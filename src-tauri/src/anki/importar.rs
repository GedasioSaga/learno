//! Gravar no banco do Learno uma coleção lida por [`super::ler_colecao`].
//!
//! Tudo numa transação: um pacote que falha no meio não deixa baralho, nota
//! ou cartão pela metade. As decisões de tradução, uma por bloco abaixo:
//!
//! - **nota já importada** (mesmo guid do Anki, `notes.anki_guid`) é pulada, e
//!   nada do que o Learno já sabe dela muda;
//! - **tipo de nota**: um padrão com 2 campos e 1 template vira o «Básico», e
//!   um cloze com 2 campos vira o «Cloze», casando campo por posição; o resto
//!   vira um tipo com o mesmo nome, campos e templates, reaproveitado numa
//!   reimportação quando nada disso mudou;
//! - **baralho** entra pelo caminho ("Medicina::Rim"), juntando com o que já
//!   existe; baralho filtrado não existe no Learno, e o cartão volta à origem;
//! - **campo** é HTML no Anki e texto no Learno ([`html_para_texto`]);
//! - **agendamento** vem como SM-2: estado, vencimento, intervalo,
//!   facilidade, repetições e lapsos;
//! - **histórico** vai para `review_log`, menos reagendamento manual, que
//!   não é resposta nenhuma.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use chrono::{DateTime, TimeZone, Utc};
use serde::Serialize;
use serde_json::Value as JsonValue;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use super::colecao::{CartaoAnki, ColecaoAnki, RevisaoAnki, TipoDeNotaAnki};
use super::{abrir_pacote, html_para_texto, ler_colecao};
use crate::db::cards::{formatar_timestamp, inicio_do_dia_local_em_utc};
use crate::db::ids::IdBind;
use crate::db::notes::{
    NoteTypeRepository, BASICO_NOTE_TYPE_NAME, CLOZE_NOTE_TYPE_NAME, NOTE_TYPE_KIND_CLOZE, NOTE_TYPE_KIND_STANDARD,
};
use crate::db::position;
use crate::error::{Error, Result};

/// Onde entra um cartão cujo baralho não está no pacote, o que só um pacote
/// corrompido produz.
const BARALHO_SEM_ORIGEM: &str = "Importado do Anki";

/// O agendamento que o Anki exporta é o do SM-2; nenhum estado FSRS vem junto.
const AGENDADOR: &str = "sm2";

const FACILIDADE_PADRAO: i64 = 250;
const SEGUNDOS_POR_DIA: i64 = 86_400;
const FILA_SUSPENSO: i64 = -1;

/// Vencimento acima disto é epoch em segundos (cartão aprendendo); abaixo, é
/// número de dias desde a criação da coleção. 10^9 s é setembro de 2001, e
/// nenhuma coleção chega a um bilhão de dias.
const LIMIAR_DE_EPOCH: i64 = 1_000_000_000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatorioDeImportacao {
    pub notas_importadas: u64,
    /// Já importadas antes (mesmo guid): puladas sem tocar no progresso feito
    /// no Learno.
    pub notas_ja_existentes: u64,
    /// Nota sem nenhum cartão no pacote não tem o que estudar e não entra.
    pub notas_sem_cartao: u64,
    pub cartoes_importados: u64,
    pub revisoes_importadas: u64,
    /// Reagendamento manual (resposta 0) e revisão de cartão que não entrou.
    pub revisoes_ignoradas: u64,
    pub baralhos_criados: u64,
    pub tipos_de_nota_criados: u64,
    /// A mídia do pacote não é copiada: a tela de estudo ainda não mostra
    /// imagem nem áudio.
    pub midias_ignoradas: u64,
}

/// Abre, lê e grava um `.apkg`/`.colpkg`.
pub async fn importar_pacote(pool: &SqlitePool, caminho: &Path) -> Result<RelatorioDeImportacao> {
    let caminho = caminho.to_path_buf();
    // Descomprimir uma coleção grande custa segundos de CPU e disco: fora do
    // executor assíncrono, para não travar os outros comandos enquanto isso.
    let pacote = tokio::task::spawn_blocking(move || abrir_pacote(&caminho))
        .await
        .map_err(|erro| Error::Config(format!("a leitura do pacote do Anki foi interrompida: {erro}")))??;
    let colecao = ler_colecao(pacote.caminho_da_colecao()).await?;
    gravar_colecao(pool, &colecao, pacote.midias, Utc::now()).await
}

/// `agora` só serve para `suspended_at`; todo vencimento vem do pacote.
pub async fn gravar_colecao(
    pool: &SqlitePool,
    colecao: &ColecaoAnki,
    midias: usize,
    agora: DateTime<Utc>,
) -> Result<RelatorioDeImportacao> {
    // Semeia «Básico» e «Cloze» se este banco nunca listou tipos de nota.
    NoteTypeRepository::new(pool.clone()).list().await?;

    let mut relatorio =
        RelatorioDeImportacao { midias_ignoradas: u64::try_from(midias).unwrap_or(u64::MAX), ..Default::default() };
    let mut tx = pool.begin().await?;

    let mut guids: HashSet<String> = sqlx::query_scalar("SELECT anki_guid FROM notes WHERE anki_guid IS NOT NULL")
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();

    let mut cartoes_por_nota: HashMap<i64, Vec<&CartaoAnki>> = HashMap::new();
    for cartao in &colecao.cartoes {
        cartoes_por_nota.entry(cartao.nota_id).or_default().push(cartao);
    }
    let tipos_do_pacote: HashMap<i64, &TipoDeNotaAnki> = colecao.tipos_de_nota.iter().map(|t| (t.id, t)).collect();
    let caminhos: HashMap<i64, &[String]> = colecao.baralhos.iter().map(|b| (b.id, b.caminho.as_slice())).collect();

    let mut baralhos = Baralhos::default();
    let mut tipos = TiposDoLearno::carregar(&mut tx).await?;
    let mut cartoes_a_gravar: Vec<(&CartaoAnki, Uuid, bool)> = Vec::new();
    // O histórico destes cartões já entrou na importação anterior: não é
    // revisão ignorada, é revisão de nota pulada.
    let mut cartoes_de_notas_puladas: HashSet<i64> = HashSet::new();

    for nota in &colecao.notas {
        if guids.contains(&nota.guid) {
            relatorio.notas_ja_existentes += 1;
            cartoes_de_notas_puladas
                .extend(cartoes_por_nota.get(&nota.id).into_iter().flatten().map(|cartao| cartao.id));
            continue;
        }
        let Some(cartoes) = cartoes_por_nota.get(&nota.id) else {
            relatorio.notas_sem_cartao += 1;
            continue;
        };
        let tipo_do_pacote = tipos_do_pacote.get(&nota.tipo_de_nota_id).ok_or_else(|| {
            Error::Invalid(format!("pacote do Anki corrompido: a nota {} usa um tipo de nota que não existe", nota.id))
        })?;
        let tipo = tipos.resolver(&mut tx, tipo_do_pacote, &mut relatorio).await?;

        // A nota mora no baralho do primeiro cartão dela; cada cartão pode morar
        // em outro, como no Anki.
        let primeiro = cartoes.iter().min_by_key(|cartao| cartao.ordinal).copied().unwrap_or(cartoes[0]);
        let baralho = baralhos.resolver(&mut tx, caminho_do_cartao(primeiro, &caminhos), &mut relatorio).await?;

        let mut valores = serde_json::Map::with_capacity(tipo.campos.len());
        for (indice, nome) in tipo.campos.iter().enumerate() {
            let html = nota.campos.get(indice).map(String::as_str).unwrap_or_default();
            valores.insert(nome.clone(), JsonValue::String(html_para_texto(html)));
        }
        let tags = JsonValue::Array(nota.tags.iter().cloned().map(JsonValue::String).collect());

        let nota_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO notes (id, note_type_id, deck_id, field_values, tags, anki_guid) VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(nota_id.db())
        .bind(tipo.id.db())
        .bind(baralho.db())
        .bind(JsonValue::Object(valores))
        .bind(tags)
        .bind(&nota.guid)
        .execute(&mut *tx)
        .await?;

        guids.insert(nota.guid.clone());
        relatorio.notas_importadas += 1;
        cartoes_a_gravar.extend(cartoes.iter().map(|cartao| (*cartao, nota_id, tipo.cloze)));
    }

    // Cartão novo sai da fila do Learno por `created_at, id`, e o id (UUIDv7)
    // cresce na ordem de inserção: inserir os novos na ordem da fila do Anki
    // é o que preserva a ordem em que eles seriam estudados lá.
    cartoes_a_gravar.sort_by_key(|(cartao, _, _)| {
        let novo = cartao.tipo == 0;
        (!novo, if novo { cartao.vencimento } else { 0 }, cartao.id)
    });

    let mut ids_dos_cartoes: HashMap<i64, Uuid> = HashMap::with_capacity(cartoes_a_gravar.len());
    for (cartao, nota_id, cloze) in cartoes_a_gravar {
        let baralho = baralhos.resolver(&mut tx, caminho_do_cartao(cartao, &caminhos), &mut relatorio).await?;
        let estado = mapear_cartao(cartao, colecao.criada_em, agora);
        // No Anki o `ord` de um cloze começa em 0 (c1 = 0); no Learno o ordinal
        // de um cloze É o número da lacuna (c1 = 1).
        let ordinal = if cloze { cartao.ordinal + 1 } else { cartao.ordinal };

        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO cards (id, note_id, template_ordinal, deck_id, state, due, scheduler, interval_days, \
             ease_factor, lapses, reps, suspended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        )
        .bind(id.db())
        .bind(nota_id.db())
        .bind(ordinal)
        .bind(baralho.db())
        .bind(estado.estado)
        .bind(&estado.vencimento)
        .bind(AGENDADOR)
        .bind(estado.intervalo_dias)
        .bind(estado.facilidade)
        .bind(cartao.lapsos)
        .bind(cartao.repeticoes)
        .bind(&estado.suspenso_em)
        .execute(&mut *tx)
        .await?;

        ids_dos_cartoes.insert(cartao.id, id);
        relatorio.cartoes_importados += 1;
    }

    let mut ultima_facilidade: HashMap<i64, i64> = HashMap::new();
    for revisao in &colecao.revisoes {
        if cartoes_de_notas_puladas.contains(&revisao.cartao_id) {
            continue;
        }
        let (Some(cartao_id), Some(importada)) = (ids_dos_cartoes.get(&revisao.cartao_id), mapear_revisao(revisao))
        else {
            relatorio.revisoes_ignoradas += 1;
            continue;
        };
        let facilidade_antes = ultima_facilidade.get(&revisao.cartao_id).copied();
        if let Some(depois) = importada.facilidade_depois {
            ultima_facilidade.insert(revisao.cartao_id, depois);
        }

        sqlx::query(
            "INSERT INTO review_log (id, card_id, reviewed_at, rating, state_before, state_after, interval_before, \
             interval_after, ease_factor_before, ease_factor_after, duration_ms, scheduler) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        )
        .bind(Uuid::now_v7().db())
        .bind(cartao_id.db())
        .bind(&importada.revisada_em)
        .bind(revisao.resposta)
        .bind(importada.estado_antes)
        .bind(importada.estado_depois)
        .bind(importada.intervalo_antes)
        .bind(importada.intervalo_depois)
        .bind(facilidade_antes)
        .bind(importada.facilidade_depois)
        .bind(importada.duracao_ms)
        .bind(AGENDADOR)
        .execute(&mut *tx)
        .await?;

        relatorio.revisoes_importadas += 1;
    }

    tx.commit().await?;
    Ok(relatorio)
}

fn caminho_do_cartao<'a>(cartao: &CartaoAnki, caminhos: &HashMap<i64, &'a [String]>) -> &'a [String] {
    caminhos.get(&cartao.baralho_id).copied().unwrap_or_default()
}

#[derive(Default)]
struct Baralhos {
    por_caminho: HashMap<Vec<String>, Uuid>,
}

impl Baralhos {
    /// O baralho do caminho, criando cada nível que ainda não existe.
    async fn resolver(
        &mut self,
        tx: &mut Transaction<'_, Sqlite>,
        caminho: &[String],
        relatorio: &mut RelatorioDeImportacao,
    ) -> Result<Uuid> {
        let caminho: Vec<String> =
            if caminho.is_empty() { vec![BARALHO_SEM_ORIGEM.to_string()] } else { caminho.to_vec() };
        if let Some(id) = self.por_caminho.get(&caminho) {
            return Ok(*id);
        }

        let mut pai: Option<Uuid> = None;
        for fim in 1..=caminho.len() {
            let prefixo = &caminho[..fim];
            let id = match self.por_caminho.get(prefixo) {
                Some(id) => *id,
                None => {
                    let id = filho(tx, pai, &caminho[fim - 1], relatorio).await?;
                    self.por_caminho.insert(prefixo.to_vec(), id);
                    id
                }
            };
            pai = Some(id);
        }
        pai.ok_or_else(|| Error::Invalid("baralho do Anki sem nome".into()))
    }
}

/// O filho ativo `nome` de `pai`, criado no fim da lista se não existir.
async fn filho(
    tx: &mut Transaction<'_, Sqlite>,
    pai: Option<Uuid>,
    nome: &str,
    relatorio: &mut RelatorioDeImportacao,
) -> Result<Uuid> {
    let existente: Option<String> = sqlx::query_scalar(
        "SELECT id FROM decks WHERE parent_id IS NOT DISTINCT FROM $1 AND name = $2 AND deleted_at IS NULL \
         ORDER BY position LIMIT 1",
    )
    .bind(pai.db())
    .bind(nome)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(id) = existente {
        return uuid_do_banco(&id);
    }

    let ultima: Option<String> = sqlx::query_scalar(
        "SELECT position FROM decks WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL \
         ORDER BY position DESC LIMIT 1",
    )
    .bind(pai.db())
    .fetch_optional(&mut **tx)
    .await?;
    let ultima = ultima.as_deref().map(position::parse).transpose()?;
    let posicao = position::between(ultima.as_ref(), None)?;

    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO decks (id, parent_id, name, position) VALUES ($1, $2, $3, $4)")
        .bind(id.db())
        .bind(pai.db())
        .bind(nome)
        .bind(&posicao)
        .execute(&mut **tx)
        .await?;
    relatorio.baralhos_criados += 1;
    Ok(id)
}

#[derive(Clone)]
struct TipoResolvido {
    id: Uuid,
    /// Os nomes dos campos NO LEARNO, na ordem dos campos do Anki.
    campos: Vec<String>,
    cloze: bool,
}

struct TipoExistente {
    id: Uuid,
    nome: String,
    kind: String,
    campos: JsonValue,
    templates: JsonValue,
}

struct TiposDoLearno {
    existentes: Vec<TipoExistente>,
    por_id_do_anki: HashMap<i64, TipoResolvido>,
}

impl TiposDoLearno {
    async fn carregar(tx: &mut Transaction<'_, Sqlite>) -> Result<Self> {
        let linhas: Vec<(String, String, String, JsonValue, JsonValue)> =
            sqlx::query_as("SELECT id, name, kind, fields, templates FROM note_types ORDER BY created_at")
                .fetch_all(&mut **tx)
                .await?;
        let existentes = linhas
            .into_iter()
            .map(|(id, nome, kind, campos, templates)| {
                Ok(TipoExistente { id: uuid_do_banco(&id)?, nome, kind, campos, templates })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self { existentes, por_id_do_anki: HashMap::new() })
    }

    async fn resolver(
        &mut self,
        tx: &mut Transaction<'_, Sqlite>,
        tipo: &TipoDeNotaAnki,
        relatorio: &mut RelatorioDeImportacao,
    ) -> Result<TipoResolvido> {
        if let Some(resolvido) = self.por_id_do_anki.get(&tipo.id) {
            return Ok(resolvido.clone());
        }

        let kind = if tipo.cloze { NOTE_TYPE_KIND_CLOZE } else { NOTE_TYPE_KIND_STANDARD };
        let embutido = match (tipo.cloze, tipo.campos.len(), tipo.templates.len()) {
            (true, 2, _) => Some(CLOZE_NOTE_TYPE_NAME),
            (false, 2, 1) => Some(BASICO_NOTE_TYPE_NAME),
            _ => None,
        };
        let campos = JsonValue::Array(tipo.campos.iter().cloned().map(JsonValue::String).collect());
        let templates = JsonValue::Array(
            tipo.templates
                .iter()
                .map(|t| serde_json::json!({ "name": t.nome, "front": t.frente, "back": t.verso }))
                .collect(),
        );

        let achado = self.existentes.iter().find(|existente| match embutido {
            Some(nome) => existente.nome == nome && existente.kind == kind,
            None => {
                existente.nome == tipo.nome
                    && existente.kind == kind
                    && existente.campos == campos
                    && existente.templates == templates
            }
        });

        let resolvido = match achado {
            Some(existente) => {
                TipoResolvido { id: existente.id, campos: nomes_dos_campos(&existente.campos)?, cloze: tipo.cloze }
            }
            None => {
                let id = Uuid::now_v7();
                sqlx::query("INSERT INTO note_types (id, name, kind, fields, templates) VALUES ($1, $2, $3, $4, $5)")
                    .bind(id.db())
                    .bind(&tipo.nome)
                    .bind(kind)
                    .bind(&campos)
                    .bind(&templates)
                    .execute(&mut **tx)
                    .await?;
                relatorio.tipos_de_nota_criados += 1;
                self.existentes.push(TipoExistente {
                    id,
                    nome: tipo.nome.clone(),
                    kind: kind.to_string(),
                    campos,
                    templates,
                });
                TipoResolvido { id, campos: tipo.campos.clone(), cloze: tipo.cloze }
            }
        };

        self.por_id_do_anki.insert(tipo.id, resolvido.clone());
        Ok(resolvido)
    }
}

fn nomes_dos_campos(campos: &JsonValue) -> Result<Vec<String>> {
    campos
        .as_array()
        .ok_or_else(|| Error::Invalid("tipo de nota corrompido: \"fields\" não é uma lista".into()))?
        .iter()
        .map(|nome| {
            nome.as_str()
                .map(str::to_string)
                .ok_or_else(|| Error::Invalid("tipo de nota corrompido: nome de campo não é texto".into()))
        })
        .collect()
}

fn uuid_do_banco(texto: &str) -> Result<Uuid> {
    Uuid::parse_str(texto).map_err(|_| Error::Invalid(format!("id corrompido no banco: {texto:?}")))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EstadoImportado {
    estado: &'static str,
    vencimento: Option<String>,
    intervalo_dias: i64,
    facilidade: i64,
    suspenso_em: Option<String>,
}

fn mapear_cartao(cartao: &CartaoAnki, criada_em: i64, agora: DateTime<Utc>) -> EstadoImportado {
    let estado = match cartao.tipo {
        1 => "learning",
        2 => "review",
        3 => "relearning",
        _ => "new",
    };
    let suspenso = cartao.fila == FILA_SUSPENSO;
    EstadoImportado {
        // Suspender no Learno sobrescreve o estado (ver `NoteRepository::delete`),
        // mas vencimento, intervalo e facilidade ficam, como no Anki.
        estado: if suspenso { "suspended" } else { estado },
        vencimento: if estado == "new" { None } else { vencimento_do_anki(cartao.vencimento, criada_em) },
        intervalo_dias: cartao.intervalo_dias.max(0),
        facilidade: facilidade_do_anki(cartao.fator).unwrap_or(FACILIDADE_PADRAO),
        suspenso_em: suspenso.then(|| formatar_timestamp(agora)),
    }
}

/// O Anki guarda a facilidade vezes 1000 (2500 = 250%); o Learno, vezes 100.
fn facilidade_do_anki(fator: i64) -> Option<i64> {
    (fator > 0).then(|| (fator + 5) / 10)
}

fn vencimento_do_anki(vencimento: i64, criada_em: i64) -> Option<String> {
    if vencimento >= LIMIAR_DE_EPOCH {
        return Utc.timestamp_opt(vencimento, 0).single().map(formatar_timestamp);
    }
    // Revisão vence num DIA, e o dia que conta é o local, como no resto do
    // Learno (I5): meia-noite local daquele dia, gravada em UTC.
    let segundos = criada_em.checked_add(vencimento.checked_mul(SEGUNDOS_POR_DIA)?)?;
    let instante = Utc.timestamp_opt(segundos, 0).single()?;
    Some(formatar_timestamp(inicio_do_dia_local_em_utc(instante, 0)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RevisaoImportada {
    revisada_em: String,
    estado_antes: &'static str,
    estado_depois: &'static str,
    intervalo_antes: i64,
    intervalo_depois: i64,
    facilidade_depois: Option<i64>,
    duracao_ms: Option<i64>,
}

/// `None` para o que não é resposta (reagendamento manual, resposta 0) ou tem
/// instante impossível.
fn mapear_revisao(revisao: &RevisaoAnki) -> Option<RevisaoImportada> {
    if !(1..=4).contains(&revisao.resposta) {
        return None;
    }
    // Intervalo negativo no Anki é um passo de aprendizagem em segundos.
    let depois_aprendendo = revisao.intervalo < 0;
    let (estado_antes, estado_depois) = match revisao.tipo {
        0 => (
            if revisao.intervalo_anterior == 0 { "new" } else { "learning" },
            if depois_aprendendo { "learning" } else { "review" },
        ),
        2 => ("relearning", if depois_aprendendo { "relearning" } else { "review" }),
        _ => ("review", if depois_aprendendo { "relearning" } else { "review" }),
    };
    Some(RevisaoImportada {
        revisada_em: Utc.timestamp_millis_opt(revisao.id).single().map(formatar_timestamp)?,
        estado_antes,
        estado_depois,
        intervalo_antes: revisao.intervalo_anterior.max(0),
        intervalo_depois: revisao.intervalo.max(0),
        facilidade_depois: facilidade_do_anki(revisao.fator),
        duracao_ms: (revisao.duracao_ms > 0).then_some(revisao.duracao_ms),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use chrono::{Local, Timelike};

    use super::*;

    const CRIADA_EM: i64 = 1_698_562_800;

    fn cartao(tipo: i64, fila: i64, vencimento: i64) -> CartaoAnki {
        CartaoAnki {
            id: 1,
            nota_id: 1,
            baralho_id: 1,
            ordinal: 0,
            tipo,
            fila,
            vencimento,
            intervalo_dias: 10,
            fator: 2500,
            repeticoes: 3,
            lapsos: 1,
        }
    }

    fn agora() -> DateTime<Utc> {
        Utc.timestamp_opt(1_750_000_000, 0).single().unwrap()
    }

    #[test]
    fn revisao_vence_a_meia_noite_local_do_dia_contado_da_criacao() {
        let estado = mapear_cartao(&cartao(2, 2, 900), CRIADA_EM, agora());

        assert_eq!(estado.estado, "review");
        let vencimento = DateTime::parse_from_rfc3339(estado.vencimento.as_deref().unwrap()).unwrap();
        let local = vencimento.with_timezone(&Local);
        let dia_esperado = Local.timestamp_opt(CRIADA_EM + 900 * SEGUNDOS_POR_DIA, 0).single().unwrap().date_naive();
        assert_eq!(local.date_naive(), dia_esperado);
        assert_eq!((local.hour(), local.minute(), local.second()), (0, 0, 0));
        assert_eq!((estado.intervalo_dias, estado.facilidade), (10, 250));
    }

    #[test]
    fn aprendendo_vence_no_instante_exato() {
        let estado = mapear_cartao(&cartao(1, 1, 1_776_643_820), CRIADA_EM, agora());
        assert_eq!(estado.estado, "learning");
        assert_eq!(
            estado.vencimento.as_deref(),
            Some(formatar_timestamp(Utc.timestamp_opt(1_776_643_820, 0).single().unwrap()).as_str())
        );
    }

    #[test]
    fn aprendendo_entre_dias_vence_num_dia() {
        let estado = mapear_cartao(&cartao(3, 3, 900), CRIADA_EM, agora());
        assert_eq!(estado.estado, "relearning");
        assert_eq!(estado.vencimento, mapear_cartao(&cartao(2, 2, 900), CRIADA_EM, agora()).vencimento);
    }

    #[test]
    fn novo_nao_tem_vencimento_e_fator_zero_usa_o_padrao() {
        let estado = mapear_cartao(&CartaoAnki { fator: 0, ..cartao(0, 0, 42) }, CRIADA_EM, agora());
        assert_eq!((estado.estado, estado.vencimento, estado.facilidade), ("new", None, FACILIDADE_PADRAO));
    }

    #[test]
    fn suspenso_guarda_o_agendamento_e_marca_quando() {
        let estado = mapear_cartao(&cartao(2, FILA_SUSPENSO, 900), CRIADA_EM, agora());
        assert_eq!(estado.estado, "suspended");
        assert!(estado.vencimento.is_some());
        assert_eq!(estado.suspenso_em.as_deref(), Some(formatar_timestamp(agora()).as_str()));
    }

    #[test]
    fn enterrado_volta_ao_estado_do_tipo() {
        assert_eq!(mapear_cartao(&cartao(2, -2, 900), CRIADA_EM, agora()).estado, "review");
    }

    #[test]
    fn facilidade_arredonda_para_a_escala_do_learno() {
        assert_eq!(facilidade_do_anki(2500), Some(250));
        assert_eq!(facilidade_do_anki(1305), Some(131));
        assert_eq!(facilidade_do_anki(0), None);
    }

    fn revisao(resposta: i64, tipo: i64, intervalo: i64, intervalo_anterior: i64) -> RevisaoAnki {
        RevisaoAnki {
            id: 1_700_000_000_000,
            cartao_id: 1,
            resposta,
            intervalo,
            intervalo_anterior,
            fator: 2500,
            duracao_ms: 8000,
            tipo,
        }
    }

    #[test]
    fn reagendamento_manual_nao_e_revisao() {
        assert_eq!(mapear_revisao(&revisao(0, 4, 10, 5)), None);
        assert_eq!(mapear_revisao(&revisao(5, 1, 10, 5)), None);
    }

    #[test]
    fn revisao_traz_instante_estados_e_intervalos() {
        let importada = mapear_revisao(&revisao(3, 1, 10, 4)).unwrap();
        assert_eq!(importada.revisada_em, "2023-11-14T22:13:20.000Z");
        assert_eq!((importada.estado_antes, importada.estado_depois), ("review", "review"));
        assert_eq!((importada.intervalo_antes, importada.intervalo_depois), (4, 10));
        assert_eq!((importada.facilidade_depois, importada.duracao_ms), (Some(250), Some(8000)));
    }

    #[test]
    fn primeira_resposta_de_cartao_novo_sai_de_new() {
        let importada = mapear_revisao(&revisao(1, 0, -600, 0)).unwrap();
        assert_eq!((importada.estado_antes, importada.estado_depois), ("new", "learning"));
        assert_eq!(importada.intervalo_depois, 0);
    }

    #[test]
    fn lapso_em_revisao_vai_para_reaprendendo() {
        let importada = mapear_revisao(&revisao(1, 1, -600, 20)).unwrap();
        assert_eq!((importada.estado_antes, importada.estado_depois), ("review", "relearning"));
    }
}
