//! E1 — `RecordEffect`: o motor único que cinco mecanismos compartilham
//! (arquitetura §7): template (E2), botão de página (DBS-112), propriedade
//! Botão (DBS-113), automação (DBS-121) e deslocamento de dependência
//! (DBS-119). Em vez de cinco motores aplicando "um conjunto de mudanças a
//! um ou mais registros" cada um do seu jeito, um `RecordEffect` declara o
//! conjunto e este arquivo é o único lugar que sabe executá-lo.
//!
//! Três responsabilidades, nesta ordem, a cada chamada de
//! [`EffectRepository::run_record_effect`]:
//!
//! 1. **Validar referências** ([`EffectRepository::validate_record_effect_references`])
//!    — DBS-117 generalizado: database, propriedade ou opção apagada vira um
//!    [`BrokenReference`] no relatório, nunca um erro opaco nem uma escrita
//!    silenciosamente incompleta.
//! 2. **Resolver o registro-alvo** — o registro de contexto quando `createIn`
//!    está ausente, ou um registro novo quando presente (ver a nota grande
//!    sobre `fromTemplate` abaixo — duplicar o CORPO de um template não é
//!    trabalho desta peça).
//! 3. **Aplicar os `writes`** — cada um vira um valor final resolvido e a
//!    escrita de fato passa SEMPRE por
//!    [`crate::db::record_values::RecordValueRepository::apply_record_value_changes`]
//!    (I4: é o único caminho de escrita em `database_record_values`; este
//!    arquivo não emite `INSERT`/`UPDATE`/`DELETE` nessa tabela em lugar
//!    nenhum).
//!
//! ## Por que `fromTemplate` não cria a página aqui
//!
//! Arquitetura §7: "Template não cabe inteiro no efeito: carrega também um
//! **corpo de blocos**, que é cópia de página, não escrita de propriedade.
//! São dois motores (executor + duplicação de página ...), e é melhor
//! admitir do que inchar `RecordEffect`." Este arquivo É o motor "executor".
//! A duplicação de página+blocos é o motor da peça E2, que ainda não existe
//! neste momento — ver `divergencias_da_arquitetura` no relatório desta peça
//! para a assinatura exata que este arquivo espera de quem chama com
//! `fromTemplate` presente.
//!
//! ## Cuidado com laço
//!
//! Um efeito que edita uma propriedade pode disparar, via
//! `record_values::dispatch_property_changed_automations` (gancho ainda vazio,
//! preenchido pela peça E3), outra automação que aplica outro efeito — que
//! por sua vez pode editar a propriedade de novo. [`EffectExecutionContext`]
//! é o parâmetro que este executor ACEITA para isso: o orçamento de
//! profundidade e o conjunto de pares já disparados são semântica de E3 (o
//! `automation_id` nem existe neste arquivo), mas o tipo mora aqui porque é
//! este executor quem cada chamada recursiva atravessa.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::position;
use crate::db::record_values::{AppliedRecordValue, RecordValueChangeInput, RecordValueRepository};
use crate::error::{Error, Result};

/// Cascata máxima de efeito disparando efeito (arquitetura §7: "`depth`
/// máximo 5"). Este executor recusa antes de escrever quando o chamador (E3)
/// já empilhou esta profundidade — rede de segurança própria, mesmo que E3
/// também tenha a sua.
pub const MAX_EFFECT_DEPTH: u32 = 5;

// =====================================================================
// RecordEffect — espelho literal de `docs/FASE-3-ARQUITETURA.md` §7.
// =====================================================================

/// De onde vem o valor de UM [`PropertyWrite`]. Espelha o `ValueSource` da
/// arquitetura campo a campo; `#[serde(tag = "kind")]` produz exatamente o
/// `{ "kind": "literal", "value": ... }` que o `contract.ts` descreve.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ValueSource {
    Literal { value: JsonValue },
    Today,
    Now,
    CopyFrom { property_id: Uuid },
}

/// Uma mudança pedida em UMA propriedade. `property_name_at_config_time` é o
/// snapshot que faz DBS-117 avisar "propriedade apagada" com um NOME em vez
/// de um id nu, mesmo depois que a propriedade de verdade sumiu de
/// `database_properties` — é a mesma ideia que a arquitetura já usa para
/// dizer que renomear não quebra o efeito (a identidade é o `property_id`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyWrite {
    pub property_id: Uuid,
    pub property_name_at_config_time: String,
    pub op: PropertyWriteOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<ValueSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PropertyWriteOp {
    Set,
    Clear,
    Add,
    Remove,
    Increment,
    Toggle,
}

/// A descrição declarativa de um conjunto de mudanças. Espelho literal do
/// `RecordEffect` da arquitetura §7.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordEffect {
    /// Presente => cria registro nesta database. Ausente => edita o registro
    /// de contexto (`context_record_id` do executor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_in: Option<Uuid>,
    /// Presente => o registro novo nasce de um template. Ver a nota do
    /// módulo: este executor NÃO duplica página nem blocos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_template: Option<Uuid>,
    pub writes: Vec<PropertyWrite>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_after: Option<OpenAfter>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenAfter {
    None,
    SidePeek,
    FullPage,
}

// =====================================================================
// BrokenReference — DBS-117 generalizado (arquitetura §7).
// =====================================================================

/// Quem "possui" o `RecordEffect` sendo validado — um `RecordEffect` sozinho
/// não carrega essa informação (ela mora no botão/automação/template que o
/// embute), por isso todo chamador de
/// [`EffectRepository::validate_record_effect_references`] precisa fornecer
/// `where_`/`owner_id` explicitamente. `FormulaProp`/`RollupSource` estão
/// aqui só para fechar o enum que a arquitetura define uma vez para todo
/// DBS-117 — nenhum caminho deste arquivo os produz (motor de fórmula/rollup
/// é de outra peça).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BrokenReferenceOwner {
    ButtonBlock,
    ButtonProperty,
    Automation,
    ViewDefaultTemplate,
    DatabaseDefaultTemplate,
    DependencyDateProperty,
    FormulaProp,
    RollupSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MissingKind {
    Database,
    Property,
    #[serde(rename = "option")]
    OptionValue,
    Template,
    Relation,
}

/// Espelho literal do `BrokenReference` da arquitetura §7. `missing_id` é
/// sempre um id de linha (database/property/template) ou de opção — todos
/// UUID nesta base de código — mesmo a interface TS declarando `string`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenReference {
    #[serde(rename = "where")]
    pub where_: BrokenReferenceOwner,
    pub owner_id: Uuid,
    pub missing: MissingKind,
    pub missing_id: Uuid,
    /// Vazio para `Database`/`Template`: nem `RecordEffect.createIn` nem
    /// `.fromTemplate` guardam um snapshot de nome (só `PropertyWrite` tem
    /// `propertyNameAtConfigTime`) — ver `divergencias_da_arquitetura`.
    pub last_known_name: String,
}

// =====================================================================
// Contexto de laço — publicado para a peça E3 preencher (ver módulo).
// =====================================================================

#[derive(Debug, Clone, Default)]
pub struct EffectExecutionContext {
    /// Quantos efeitos já estão empilhados nesta cadeia (clique → automação
    /// → automação ...). Um disparo de UI começa em `0`; cada chamada
    /// recursiva que E3 fizer para `run_record_effect` incrementa antes de
    /// chamar de novo.
    pub depth: u32,
    /// Pares já disparados nesta cadeia. Opaco para este executor —
    /// semântica de automação (E3), que decide o formato real do par (aqui
    /// é `(disparador, registro)` só para dar um tipo concreto ao campo);
    /// existe para ser TRANSPORTADO por uma chamada recursiva sem se perder
    /// no caminho, não para este arquivo consultar.
    pub already_fired: HashSet<(Uuid, Uuid)>,
}

// =====================================================================
// Resultado.
// =====================================================================

/// O que `run_record_effect` devolve. `record_id: None` só no caso em que
/// NENHUMA escrita é segura de tentar (`createIn`/`fromTemplate` aponta para
/// algo que sumiu — sem alvo confiável não há o que criar nem editar).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectOutcome {
    pub record_id: Option<Uuid>,
    pub created_record: bool,
    /// Um item por escrita REALMENTE aplicada, na ordem em que
    /// `apply_record_value_changes` as processou. Escritas puladas por
    /// referência quebrada não aparecem aqui — contam em `skipped_writes`.
    pub applied: Vec<AppliedRecordValue>,
    /// Nunca falha em silêncio (DBS-117): toda referência quebrada
    /// encontrada, mesmo quando o efeito ainda consegue aplicar as escritas
    /// válidas.
    pub broken_references: Vec<BrokenReference>,
    pub skipped_writes: usize,
}

// =====================================================================
// Metadado de propriedade — lido uma vez, reusado pela validação e pela
// resolução de valor.
// =====================================================================

#[derive(Debug, Clone, sqlx::FromRow)]
struct PropertyMeta {
    id: Uuid,
    property_type: String,
    config: JsonValue,
}

// =====================================================================
// O repositório.
// =====================================================================

pub struct EffectRepository {
    pool: SqlitePool,
}

impl EffectRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// O executor. Sempre passa pelas três etapas do topo do módulo; nunca
    /// escreve em `database_record_values` diretamente (I4).
    pub async fn run_record_effect(
        &self,
        effect: RecordEffect,
        context_record_id: Option<Uuid>,
        pre_created_record_id: Option<Uuid>,
        ctx: &EffectExecutionContext,
        where_: BrokenReferenceOwner,
        owner_id: Uuid,
    ) -> Result<EffectOutcome> {
        if ctx.depth >= MAX_EFFECT_DEPTH {
            return Err(Error::Invalid(format!(
                "efeito recusado: profundidade {} atingiu o orçamento máximo de {MAX_EFFECT_DEPTH} — provável ciclo entre automações",
                ctx.depth
            )));
        }

        let broken_references = self.validate_record_effect_references(&effect, where_, owner_id).await?;

        // Referência quebrada em `createIn`/`fromTemplate` não deixa alvo
        // nenhum para criar ou editar — sem alvo, nenhuma das escritas é
        // tentada (a leitura de "nunca escrever pela metade" mais estrita
        // possível aqui). Propriedade/opção quebrada em um `write`
        // individual é tratada de forma mais branda em `apply_writes`: as
        // OUTRAS escritas do mesmo efeito continuam válidas.
        let target_is_unreachable = broken_references
            .iter()
            .any(|reference| matches!(reference.missing, MissingKind::Database | MissingKind::Template));
        if target_is_unreachable {
            return Ok(EffectOutcome {
                record_id: None,
                created_record: false,
                applied: Vec::new(),
                broken_references,
                skipped_writes: effect.writes.len(),
            });
        }

        let (target_record_id, created_record) =
            self.resolve_target(&effect, context_record_id, pre_created_record_id).await?;

        let (applied, skipped_writes) = self
            .apply_writes(target_record_id, context_record_id, &effect.writes, &broken_references)
            .await?;

        Ok(EffectOutcome {
            record_id: Some(target_record_id),
            created_record,
            applied,
            broken_references,
            skipped_writes,
        })
    }

    /// O validador de referências quebradas que DBS-117 exige, exposto à
    /// parte (S9 quer mostrar o aviso ANTES de disparar um botão; C1 quer
    /// validar a database inteira do CSV sem executar nada). Nunca lança por
    /// causa de referência quebrada — o `Result::Err` daqui é só erro de
    /// banco (conexão caiu etc.), nunca "achei algo faltando".
    pub async fn validate_record_effect_references(
        &self,
        effect: &RecordEffect,
        where_: BrokenReferenceOwner,
        owner_id: Uuid,
    ) -> Result<Vec<BrokenReference>> {
        let mut broken = Vec::new();

        if let Some(database_id) = effect.create_in {
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM databases WHERE id = $1)")
                .bind(database_id)
                .fetch_one(&self.pool)
                .await?;
            if !exists {
                broken.push(BrokenReference {
                    where_,
                    owner_id,
                    missing: MissingKind::Database,
                    missing_id: database_id,
                    last_known_name: String::new(),
                });
            }
        }

        if let Some(template_id) = effect.from_template {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pages WHERE id = $1 AND is_template = true AND deleted_at IS NULL)",
            )
            .bind(template_id)
            .fetch_one(&self.pool)
            .await?;
            if !exists {
                broken.push(BrokenReference {
                    where_,
                    owner_id,
                    missing: MissingKind::Template,
                    missing_id: template_id,
                    last_known_name: String::new(),
                });
            }
        }

        let mut property_ids: Vec<Uuid> = effect.writes.iter().map(|write| write.property_id).collect();
        for write in &effect.writes {
            if let Some(ValueSource::CopyFrom { property_id }) = &write.from {
                property_ids.push(*property_id);
            }
        }
        property_ids.sort_unstable();
        property_ids.dedup();

        let properties = self.fetch_property_metas(&property_ids).await?;

        for write in &effect.writes {
            match properties.get(&write.property_id) {
                None => broken.push(BrokenReference {
                    where_,
                    owner_id,
                    missing: MissingKind::Property,
                    missing_id: write.property_id,
                    last_known_name: write.property_name_at_config_time.clone(),
                }),
                Some(meta) => {
                    if let Some(ValueSource::Literal { value }) = &write.from {
                        broken.extend(missing_options(
                            meta,
                            value,
                            where_,
                            owner_id,
                            &write.property_name_at_config_time,
                        ));
                    }
                }
            }

            if let Some(ValueSource::CopyFrom { property_id }) = &write.from {
                if !properties.contains_key(property_id) {
                    broken.push(BrokenReference {
                        where_,
                        owner_id,
                        missing: MissingKind::Property,
                        missing_id: *property_id,
                        // `ValueSource::CopyFrom` não carrega um snapshot de
                        // nome (só o ALVO de um `PropertyWrite` tem
                        // `propertyNameAtConfigTime`) — mesma divergência de
                        // `createIn`/`fromTemplate` acima.
                        last_known_name: String::new(),
                    });
                }
            }
        }

        Ok(broken)
    }

    /// `createIn` ausente => o alvo é `context_record_id`. `createIn`
    /// presente COM `fromTemplate` => o CHAMADOR (E2) já duplicou a
    /// página+blocos do template e entrega o id em `pre_created_record_id`
    /// (ver a nota grande do módulo — duplicar corpo de blocos não é este
    /// arquivo). `createIn` presente SEM `fromTemplate` => uma página nova e
    /// vazia é exatamente o que este executor sabe criar sozinho, sem
    /// depender do motor de duplicação.
    async fn resolve_target(
        &self,
        effect: &RecordEffect,
        context_record_id: Option<Uuid>,
        pre_created_record_id: Option<Uuid>,
    ) -> Result<(Uuid, bool)> {
        let Some(database_id) = effect.create_in else {
            let record_id = context_record_id.ok_or_else(|| {
                Error::Invalid(
                    "RecordEffect sem createIn precisa de context_record_id (o registro que disparou o efeito)"
                        .to_string(),
                )
            })?;
            return Ok((record_id, false));
        };

        if effect.from_template.is_some() {
            let record_id = pre_created_record_id.ok_or_else(|| {
                Error::Invalid(
                    "RecordEffect com fromTemplate exige pre_created_record_id: este executor não duplica \
                     página nem blocos — isso é o motor de template (E2)"
                        .to_string(),
                )
            })?;
            return Ok((record_id, true));
        }

        if let Some(record_id) = pre_created_record_id {
            return Ok((record_id, true));
        }

        let record_id = self.create_bare_record(database_id).await?;
        Ok((record_id, true))
    }

    /// Uma página nova, vazia, como último registro de topo da database —
    /// sem template, sem corpo de blocos para copiar. `parent_id = NULL`:
    /// sub-itens (DBS-118) são um passo de reparenting posterior, não parte
    /// da criação.
    async fn create_bare_record(&self, database_id: Uuid) -> Result<Uuid> {
        let mut tx = self.pool.begin().await?;

        let last_position: Option<String> = sqlx::query_scalar(
            "SELECT position FROM pages WHERE database_id = $1 AND parent_id IS NULL AND deleted_at IS NULL \
             ORDER BY position DESC LIMIT 1",
        )
        .bind(database_id)
        .fetch_optional(&mut *tx)
        .await?;

        let new_position = match last_position {
            Some(raw) => {
                let parsed = position::parse(&raw)?;
                position::between(Some(&parsed), None)?
            }
            None => position::first(),
        };

        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO pages (id, database_id, parent_id, title, position) VALUES ($1, $2, NULL, '', $3)")
            .bind(id)
            .bind(database_id)
            .bind(&new_position)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(id)
    }

    /// Resolve cada `PropertyWrite` num valor final e entrega o lote inteiro
    /// numa ÚNICA chamada a `apply_record_value_changes` — a transação de
    /// I4 cobre a escrita de todas as células válidas juntas. Escritas cuja
    /// propriedade já apareceu em `broken` (ou some entre a validação e
    /// aqui) são puladas, nunca meio-aplicadas.
    async fn apply_writes(
        &self,
        target_record_id: Uuid,
        context_record_id: Option<Uuid>,
        writes: &[PropertyWrite],
        broken: &[BrokenReference],
    ) -> Result<(Vec<AppliedRecordValue>, usize)> {
        let broken_property_ids: HashSet<Uuid> = broken
            .iter()
            .filter(|reference| reference.missing == MissingKind::Property)
            .map(|reference| reference.missing_id)
            .collect();

        let property_ids: Vec<Uuid> = writes.iter().map(|write| write.property_id).collect();
        let properties = self.fetch_property_metas(&property_ids).await?;
        let current_values = self.fetch_current_values(target_record_id, &property_ids).await?;

        let mut changes = Vec::with_capacity(writes.len());
        let mut skipped = 0usize;

        for write in writes {
            if broken_property_ids.contains(&write.property_id) {
                skipped += 1;
                continue;
            }
            let Some(meta) = properties.get(&write.property_id) else {
                // Já reportado por `validate_record_effect_references`;
                // defesa extra caso um chamador ignore o relatório e chame
                // esta função direto.
                skipped += 1;
                continue;
            };
            let current = current_values.get(&write.property_id);

            let resolved = self.resolve_write_value(meta, write, current, context_record_id).await?;

            changes.push(RecordValueChangeInput {
                record_id: target_record_id,
                property_id: write.property_id,
                value: resolved,
            });
        }

        if changes.is_empty() {
            return Ok((Vec::new(), skipped));
        }

        // I4: o único caminho de escrita. Nenhuma linha deste arquivo emite
        // INSERT/UPDATE/DELETE em `database_record_values` — este é o ponto
        // de passagem obrigatório, e é aqui, dentro da MESMA transação, que
        // os ganchos de automação/fórmula/rollup de `record_values.rs`
        // rodam para cada célula do lote.
        let repository = RecordValueRepository::new(self.pool.clone());
        let outcome = repository.apply_record_value_changes(changes).await?;
        Ok((outcome.results, skipped))
    }

    /// Um valor final para UM `PropertyWrite`. Nunca lê nem escreve
    /// `database_record_values` diretamente — só orquestra o que
    /// `apply_writes`/`RecordValueRepository` fazem de fato.
    async fn resolve_write_value(
        &self,
        meta: &PropertyMeta,
        write: &PropertyWrite,
        current: Option<&JsonValue>,
        context_record_id: Option<Uuid>,
    ) -> Result<JsonValue> {
        match write.op {
            PropertyWriteOp::Clear => Ok(JsonValue::Null),

            PropertyWriteOp::Set => {
                let source = require_source(write)?;
                self.resolve_source(meta, source, context_record_id).await
            }

            PropertyWriteOp::Toggle => {
                let is_true = matches!(current, Some(JsonValue::Bool(true)));
                Ok(JsonValue::Bool(!is_true))
            }

            PropertyWriteOp::Increment => {
                let source = require_source(write)?;
                let delta_value = self.resolve_source(meta, source, context_record_id).await?;
                let delta = delta_value.as_f64().ok_or_else(|| {
                    Error::Invalid(format!(
                        "write em \"{}\" com op=increment precisa de um número em `from`",
                        write.property_name_at_config_time
                    ))
                })?;
                let base = current.and_then(JsonValue::as_f64).unwrap_or(0.0);
                let total = base + delta;
                if !total.is_finite() {
                    return Err(Error::Invalid(format!(
                        "write em \"{}\": incremento produziria um número não representável em JSON (infinito/NaN)",
                        write.property_name_at_config_time
                    )));
                }
                serde_json::Number::from_f64(total).map(JsonValue::Number).ok_or_else(|| {
                    Error::Invalid(format!(
                        "write em \"{}\": resultado do incremento não é um número JSON válido",
                        write.property_name_at_config_time
                    ))
                })
            }

            PropertyWriteOp::Add => {
                let source = require_source(write)?;
                let delta_value = self.resolve_source(meta, source, context_record_id).await?;
                let delta_items = as_item_list(&delta_value);
                let mut merged = current_array_or_err(current, write)?;
                for item in delta_items {
                    if !merged.contains(&item) {
                        merged.push(item);
                    }
                }
                Ok(JsonValue::Array(merged))
            }

            PropertyWriteOp::Remove => {
                let source = require_source(write)?;
                let delta_value = self.resolve_source(meta, source, context_record_id).await?;
                let delta_items = as_item_list(&delta_value);
                let current_items = current_array_or_err(current, write)?;
                let result: Vec<JsonValue> =
                    current_items.into_iter().filter(|item| !delta_items.contains(item)).collect();
                Ok(JsonValue::Array(result))
            }
        }
    }

    async fn resolve_source(
        &self,
        meta: &PropertyMeta,
        source: &ValueSource,
        context_record_id: Option<Uuid>,
    ) -> Result<JsonValue> {
        match source {
            ValueSource::Literal { value } => Ok(value.clone()),
            ValueSource::Today => Ok(today_value(&meta.property_type)),
            ValueSource::Now => Ok(now_value(&meta.property_type)),
            ValueSource::CopyFrom { property_id } => {
                let record_id = context_record_id.ok_or_else(|| {
                    Error::Invalid(
                        "ValueSource::CopyFrom precisa de context_record_id (o registro de origem)".to_string(),
                    )
                })?;
                let values = self.fetch_current_values(record_id, std::slice::from_ref(property_id)).await?;
                Ok(values.get(property_id).cloned().unwrap_or(JsonValue::Null))
            }
        }
    }

    async fn fetch_property_metas(&self, property_ids: &[Uuid]) -> Result<HashMap<Uuid, PropertyMeta>> {
        if property_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<PropertyMeta> =
            sqlx::query_as("SELECT id, property_type, config FROM database_properties WHERE id = ANY($1)")
                .bind(property_ids)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.into_iter().map(|row| (row.id, row)).collect())
    }

    /// Leitura FORA da transação de escrita: `RecordValueRepository` (I4)
    /// não expõe uma variante que aceite uma `Transaction` externa, então
    /// "ler o valor atual" e "escrever o valor resolvido" não são atômicos
    /// entre si para os `op`s que dependem do valor anterior
    /// (add/remove/increment/toggle). Num app desktop local de um usuário só
    /// isso é uma janela de corrida que não existe na prática (não há duas
    /// sessões escrevendo a mesma célula ao mesmo tempo); documentado aqui
    /// em vez de escondido. A ESCRITA em si (`apply_writes`) continua
    /// atômica: todas as células válidas do efeito committam juntas ou
    /// nenhuma commita.
    async fn fetch_current_values(&self, record_id: Uuid, property_ids: &[Uuid]) -> Result<HashMap<Uuid, JsonValue>> {
        if property_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(Uuid, JsonValue)> = sqlx::query_as(
            "SELECT property_id, value FROM database_record_values WHERE record_id = $1 AND property_id = ANY($2)",
        )
        .bind(record_id)
        .bind(property_ids)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().collect())
    }
}

fn require_source(write: &PropertyWrite) -> Result<&ValueSource> {
    write.from.as_ref().ok_or_else(|| {
        Error::Invalid(format!(
            "write em \"{}\" com op={:?} precisa de `from`",
            write.property_name_at_config_time, write.op
        ))
    })
}

fn current_array_or_err(current: Option<&JsonValue>, write: &PropertyWrite) -> Result<Vec<JsonValue>> {
    match current {
        None => Ok(Vec::new()),
        Some(JsonValue::Array(items)) => Ok(items.clone()),
        Some(_) => Err(Error::Invalid(format!(
            "write em \"{}\" com op={:?}: valor atual não é uma lista",
            write.property_name_at_config_time, write.op
        ))),
    }
}

fn as_item_list(value: &JsonValue) -> Vec<JsonValue> {
    match value {
        JsonValue::Array(items) => items.clone(),
        JsonValue::Null => Vec::new(),
        other => vec![other.clone()],
    }
}

/// I5: data ISO de largura fixa, HORA LOCAL de parede — nunca UTC (o app é
/// local, de um usuário só, sem servidor e sem sync; arquitetura §2 I5).
/// Propriedade `date` recebe a forma `{ "start": ... }`; qualquer outro tipo
/// (ex.: `text`, para um template que grava "criado em" como texto simples)
/// recebe a string ISO nua.
fn today_value(property_type: &str) -> JsonValue {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if property_type == "date" {
        serde_json::json!({ "start": today })
    } else {
        JsonValue::String(today)
    }
}

/// Mesma forma que [`today_value`], com hora e SEM segundos (I5).
fn now_value(property_type: &str) -> JsonValue {
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string();
    if property_type == "date" {
        serde_json::json!({ "start": now })
    } else {
        JsonValue::String(now)
    }
}

/// Ids de opção que um valor LITERAL referencia, segundo `property_type` —
/// não segundo um `ValueShape` completo (esse registro é TypeScript, fora do
/// alcance deste arquivo). `select`/`status` guardam UM id (string, I6);
/// `multi_select` guarda uma lista deles. Qualquer outro tipo, ou uma forma
/// de valor que não bate com o esperado (ex.: um objeto em vez de string),
/// devolve vazio — nunca supõe intenção que o dado não expressa.
fn extract_option_ids(property_type: &str, value: &JsonValue) -> Vec<Uuid> {
    match property_type {
        "select" | "status" => value.as_str().and_then(|id| Uuid::parse_str(id).ok()).into_iter().collect(),
        "multi_select" => value
            .as_array()
            .map(|items| {
                items.iter().filter_map(JsonValue::as_str).filter_map(|id| Uuid::parse_str(id).ok()).collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Os ids conhecidos em `config.options` (`[{ "id": ..., ... }, ...]`) — a
/// forma mais convencional para uma lista de opções nesta base de código,
/// mas NENHUMA migração fixa esse formato ainda (`database_properties.config`
/// é `jsonb` livre até a peça que implementa o registro de tipos landar).
/// `None` — não "sem opções conhecidas", mas "não sei ler esta config" —
/// quando a chave nem existe ou não é um array: never produz falso-positivo
/// aqui, só deixa de detectar um caso real. Ver `divergencias_da_arquitetura`.
fn known_option_ids(config: &JsonValue) -> Option<HashSet<Uuid>> {
    let options = config.get("options")?.as_array()?;
    Some(options.iter().filter_map(|option| option.get("id")?.as_str()).filter_map(|id| Uuid::parse_str(id).ok()).collect())
}

fn missing_options(
    meta: &PropertyMeta,
    value: &JsonValue,
    where_: BrokenReferenceOwner,
    owner_id: Uuid,
    property_name: &str,
) -> Vec<BrokenReference> {
    let candidate_ids = extract_option_ids(&meta.property_type, value);
    if candidate_ids.is_empty() {
        return Vec::new();
    }
    let Some(known_ids) = known_option_ids(&meta.config) else {
        return Vec::new();
    };
    candidate_ids
        .into_iter()
        .filter(|id| !known_ids.contains(id))
        .map(|missing_id| BrokenReference {
            where_,
            owner_id,
            missing: MissingKind::OptionValue,
            missing_id,
            last_known_name: property_name.to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here —
    // same pattern as `db::record_values`'s own test module.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn sample_write(op: PropertyWriteOp, from: Option<ValueSource>) -> PropertyWrite {
        PropertyWrite { property_id: Uuid::new_v4(), property_name_at_config_time: "Status".to_string(), op, from }
    }

    #[test]
    fn effect_deserializes_from_the_architecture_shape() {
        let json = serde_json::json!({
            "writes": [
                {
                    "propertyId": "11111111-1111-1111-1111-111111111111",
                    "propertyNameAtConfigTime": "Feito",
                    "op": "set",
                    "from": { "kind": "literal", "value": true }
                },
                {
                    "propertyId": "22222222-2222-2222-2222-222222222222",
                    "propertyNameAtConfigTime": "Prazo",
                    "op": "set",
                    "from": { "kind": "today" }
                }
            ]
        });
        let effect: RecordEffect = serde_json::from_value(json).unwrap();
        assert!(effect.create_in.is_none());
        assert!(effect.from_template.is_none());
        assert_eq!(effect.writes.len(), 2);
        assert_eq!(effect.writes[0].op, PropertyWriteOp::Set);
        assert!(matches!(effect.writes[1].from, Some(ValueSource::Today)));
    }

    #[test]
    fn broken_reference_serializes_where_as_the_reserved_keyword() {
        let reference = BrokenReference {
            where_: BrokenReferenceOwner::ButtonProperty,
            owner_id: Uuid::nil(),
            missing: MissingKind::Property,
            missing_id: Uuid::nil(),
            last_known_name: "Prioridade".to_string(),
        };
        let json = serde_json::to_value(&reference).unwrap();
        assert_eq!(json["where"], "buttonProperty");
        assert_eq!(json["missing"], "property");
    }

    #[test]
    fn extract_option_ids_reads_select_as_a_single_id() {
        let id = Uuid::new_v4();
        let value = serde_json::json!(id.to_string());
        assert_eq!(extract_option_ids("select", &value), vec![id]);
    }

    #[test]
    fn extract_option_ids_reads_multi_select_as_a_list() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let value = serde_json::json!([a.to_string(), b.to_string()]);
        assert_eq!(extract_option_ids("multi_select", &value), vec![a, b]);
    }

    /// Trap I1 menciona por nome: `0`/`false` não são "formas estranhas" a
    /// serem confundidas com id de opção — tipos que não são select/status/
    /// multi_select nunca produzem candidato nenhum.
    #[test]
    fn extract_option_ids_is_empty_for_other_types() {
        assert_eq!(extract_option_ids("number", &serde_json::json!(0)), Vec::<Uuid>::new());
        assert_eq!(extract_option_ids("checkbox", &serde_json::json!(false)), Vec::<Uuid>::new());
    }

    #[test]
    fn known_option_ids_reads_the_conventional_options_array() {
        let id = Uuid::new_v4();
        let config = serde_json::json!({ "options": [{ "id": id.to_string(), "name": "Feito" }] });
        let known = known_option_ids(&config).unwrap();
        assert!(known.contains(&id));
    }

    /// A cláusula "nunca falso-positivo": uma config sem `options`
    /// reconhecível não afirma "nenhuma opção existe" — devolve `None`, e
    /// `missing_options` trata isso como "não sei checar", não como
    /// "está tudo faltando".
    #[test]
    fn known_option_ids_is_none_for_an_unrecognised_config_shape() {
        assert!(known_option_ids(&serde_json::json!({})).is_none());
        assert!(known_option_ids(&serde_json::json!({ "options": "not-an-array" })).is_none());
    }

    #[test]
    fn missing_options_flags_an_id_absent_from_the_known_list() {
        let known_id = Uuid::new_v4();
        let missing_id = Uuid::new_v4();
        let meta = PropertyMeta {
            id: Uuid::new_v4(),
            property_type: "select".to_string(),
            config: serde_json::json!({ "options": [{ "id": known_id.to_string() }] }),
        };
        let value = serde_json::json!(missing_id.to_string());
        let broken =
            missing_options(&meta, &value, BrokenReferenceOwner::Automation, Uuid::nil(), "Status");
        assert_eq!(broken.len(), 1);
        assert_eq!(broken[0].missing_id, missing_id);
        assert_eq!(broken[0].missing, MissingKind::OptionValue);
    }

    #[test]
    fn missing_options_is_silent_when_the_id_is_known() {
        let known_id = Uuid::new_v4();
        let meta = PropertyMeta {
            id: Uuid::new_v4(),
            property_type: "select".to_string(),
            config: serde_json::json!({ "options": [{ "id": known_id.to_string() }] }),
        };
        let value = serde_json::json!(known_id.to_string());
        let broken =
            missing_options(&meta, &value, BrokenReferenceOwner::Automation, Uuid::nil(), "Status");
        assert!(broken.is_empty());
    }

    #[test]
    fn as_item_list_wraps_a_scalar_and_passes_arrays_through() {
        assert_eq!(as_item_list(&serde_json::json!("a")), vec![serde_json::json!("a")]);
        assert_eq!(as_item_list(&serde_json::json!(["a", "b"])), vec![serde_json::json!("a"), serde_json::json!("b")]);
        assert_eq!(as_item_list(&JsonValue::Null), Vec::<JsonValue>::new());
    }

    #[test]
    fn current_array_or_err_rejects_a_non_array_current_value() {
        let write = sample_write(PropertyWriteOp::Add, None);
        assert!(current_array_or_err(Some(&serde_json::json!("not a list")), &write).is_err());
        assert_eq!(current_array_or_err(None, &write).unwrap(), Vec::<JsonValue>::new());
    }

    #[test]
    fn require_source_names_the_missing_from_in_the_error() {
        let write = sample_write(PropertyWriteOp::Increment, None);
        let err = require_source(&write).unwrap_err();
        assert!(err.to_string().contains("Status"));
    }

    /// I5: sem segundos, sem fuso, largura fixa — a MESMA forma que o CHECK
    /// `chk_drv_iso_date_shape` de `0017` exige.
    #[test]
    fn today_and_now_match_the_i5_date_shape_for_a_date_property() {
        let today = today_value("date");
        let start = today["start"].as_str().unwrap();
        assert_eq!(start.len(), 10, "YYYY-MM-DD deve ter 10 caracteres: {start}");

        let now = now_value("date");
        let start = now["start"].as_str().unwrap();
        assert_eq!(start.len(), 16, "YYYY-MM-DDTHH:MM deve ter 16 caracteres: {start}");
        assert!(!start.contains('+') && !start.contains('Z'), "sem fuso: {start}");
    }

    #[test]
    fn today_and_now_are_plain_strings_outside_a_date_property() {
        assert!(today_value("text").is_string());
        assert!(now_value("text").is_string());
    }
}
