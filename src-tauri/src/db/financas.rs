//! Repository de Finanças, entrega 1 — `0043_financas.sql`.
//!
//! Três peças, mesmo desenho de `db::prazos`:
//!
//! 1. **CRUD** de categorias, recorrentes (gastos/receitas fixos) e
//!    lançamentos.
//! 2. **Histórico de valor** dos recorrentes (`mudar_valor_a_partir_de`,
//!    `encerrar_recorrente`): mudar o valor fecha a vigência anterior em vez de
//!    reescrevê-la, para o previsto de um mês passado não mudar retroativamente.
//! 3. **Funções PURAS** sobre mês de calendário (`parse_mes`, `mes_seguinte`,
//!    `mes_anterior`, `valor_vigente`, `limites_do_mes`), testáveis sem banco.
//!
//! Dinheiro é sempre `i64` em centavos; mês é `YYYY-MM` de calendário, nunca
//! instante — ver o cabeçalho da migração.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::error::{Error, Result};

/// Espelha o `CHECK (tipo IN (...))` da migração, para o IPC receber
/// `Error::Invalid` legível em vez de `Error::Database` opaco.
const TIPOS_VALIDOS: [&str; 2] = ["entrada", "saida"];

/// Defesa contra entrada hostil de IPC — mesmo teto de `db::prazos`.
const MAX_TEXTO_CHARS: usize = 500;

/// Teto defensivo de valor (R$ 100 bilhões). Não é regra de produto: garante
/// que o número cabe exato num `number` do JavaScript (< 2^53) e que somas de
/// muitos lançamentos não chegam perto do limite de `i64`.
pub const TETO_VALOR_CENTAVOS: i64 = 10_000_000_000_000;

/// Quantos meses `visao_por_meses` aceita de uma vez (3 anos): cada mês é uma
/// rodada de consultas.
pub const MAX_MESES_NA_VISAO: i64 = 36;

const CATEGORIA_COLUMNS: &str = "id, nome, tipo, ordem, arquivada, created_at, updated_at";
const RECORRENTE_COLUMNS: &str = "id, descricao, tipo, categoria_id, created_at, updated_at";
const VIGENCIA_COLUMNS: &str = "id, recorrente_id, valor_centavos, inicio_mes, fim_mes, created_at";
const LANCAMENTO_COLUMNS: &str =
    "id, data_local, descricao, tipo, categoria_id, valor_centavos, recorrente_id, mes_referencia, created_at, updated_at";

/// Uma linha de `financas_categorias`.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoriaRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub nome: String,
    pub tipo: String,
    pub ordem: i64,
    pub arquivada: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Uma linha de `financas_recorrentes` (sem o valor — ver [`VigenciaRow`]).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorrenteRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub descricao: String,
    pub tipo: String,
    #[sqlx(try_from = "DbIdOpt")]
    pub categoria_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Uma linha de `financas_vigencias`: um valor válido de `inicio_mes` até
/// `fim_mes` INCLUSIVO (`None` = sem fim).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VigenciaRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub recorrente_id: Uuid,
    pub valor_centavos: i64,
    pub inicio_mes: String,
    pub fim_mes: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Uma linha de `financas_lancamentos`.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LancamentoRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub data_local: String,
    pub descricao: String,
    pub tipo: String,
    #[sqlx(try_from = "DbIdOpt")]
    pub categoria_id: Option<Uuid>,
    pub valor_centavos: i64,
    #[sqlx(try_from = "DbIdOpt")]
    pub recorrente_id: Option<Uuid>,
    pub mes_referencia: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Um recorrente com todas as suas vigências, em ordem de `inicio_mes`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorrenteComVigencias {
    #[serde(flatten)]
    pub recorrente: RecorrenteRow,
    pub vigencias: Vec<VigenciaRow>,
}

/// Entrada de `atualizar_recorrente`. Mesma convenção de `PrazoPatchInput`:
/// ausente/`null` = sem mudança (`COALESCE`), e por isso não há como limpar
/// `categoriaId` de volta para `NULL` por aqui. O valor não entra: ele muda por
/// `mudar_valor_a_partir_de`, que preserva o histórico.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorrentePatchInput {
    pub descricao: Option<String>,
    pub tipo: Option<String>,
    pub categoria_id: Option<Uuid>,
}

/// Entrada de `atualizar_lancamento`. Mesma convenção `COALESCE`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LancamentoPatchInput {
    pub data_local: Option<String>,
    pub descricao: Option<String>,
    pub tipo: Option<String>,
    pub categoria_id: Option<Uuid>,
    pub valor_centavos: Option<i64>,
}

/// Um fixo vigente no mês e se já foi confirmado.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixoDoMes {
    pub recorrente_id: Uuid,
    pub descricao: String,
    pub tipo: String,
    pub categoria_id: Option<Uuid>,
    pub valor_previsto_centavos: i64,
    /// `Some` quando existe o lançamento de confirmação deste fixo neste mês.
    pub lancamento_id: Option<Uuid>,
    pub valor_confirmado_centavos: Option<i64>,
}

/// Saídas REALIZADAS do mês agrupadas por categoria. `categoriaId`/`nome`
/// nulos = lançamentos sem categoria.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GastoPorCategoria {
    #[sqlx(try_from = "DbIdOpt")]
    pub categoria_id: Option<Uuid>,
    pub nome: Option<String>,
    pub saidas_centavos: i64,
}

/// `resumo_financeiro_do_mes`. Todos os valores em centavos.
///
/// - previstas = recorrentes vigentes no mês + lançamentos avulsos do mês;
/// - realizadas = todos os lançamentos do mês (avulsos + confirmados);
/// - sobra = entradas − saídas (pode ser negativa).
///
/// Um fixo confirmado entra no previsto só pelo valor da vigência, nunca de
/// novo pelo lançamento (que não é avulso) — por isso não conta duas vezes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumoDoMes {
    pub mes: String,
    pub entradas_previstas: i64,
    pub saidas_previstas: i64,
    pub entradas_realizadas: i64,
    pub saidas_realizadas: i64,
    pub sobra_prevista: i64,
    pub sobra_realizada: i64,
    pub fixos: Vec<FixoDoMes>,
    pub por_categoria: Vec<GastoPorCategoria>,
}

/// Uma linha de `visao_financeira_por_meses` — os totais de [`ResumoDoMes`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinhaDoMes {
    pub mes: String,
    pub entradas_previstas: i64,
    pub saidas_previstas: i64,
    pub entradas_realizadas: i64,
    pub saidas_realizadas: i64,
    pub sobra_prevista: i64,
    pub sobra_realizada: i64,
}

impl From<&ResumoDoMes> for LinhaDoMes {
    fn from(resumo: &ResumoDoMes) -> Self {
        Self {
            mes: resumo.mes.clone(),
            entradas_previstas: resumo.entradas_previstas,
            saidas_previstas: resumo.saidas_previstas,
            entradas_realizadas: resumo.entradas_realizadas,
            saidas_realizadas: resumo.saidas_realizadas,
            sobra_prevista: resumo.sobra_prevista,
            sobra_realizada: resumo.sobra_realizada,
        }
    }
}

pub struct FinancasRepository {
    pool: SqlitePool,
}

impl FinancasRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    // -----------------------------------------------------------------------
    // Categorias
    // -----------------------------------------------------------------------

    /// `listar_categorias_financas`: só as não arquivadas, entradas antes de
    /// saídas, e dentro de cada tipo por `ordem`, `nome`.
    pub async fn listar_categorias(&self) -> Result<Vec<CategoriaRow>> {
        let rows = sqlx::query_as::<_, CategoriaRow>(&format!(
            "SELECT {CATEGORIA_COLUMNS} FROM financas_categorias WHERE arquivada = 0 ORDER BY tipo, ordem, nome"
        ))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// `criar_categoria_financas`. Entra no fim da ordem do seu tipo. Nome
    /// repetido vira `Error::Invalid` (o `UNIQUE` da migração é quem decide).
    pub async fn criar_categoria(&self, nome: &str, tipo: &str) -> Result<CategoriaRow> {
        let nome = validar_texto(nome, "nome da categoria")?;
        validar_tipo(tipo)?;

        let id = Uuid::now_v7();
        sqlx::query_as::<_, CategoriaRow>(&format!(
            "INSERT INTO financas_categorias (id, nome, tipo, ordem) \
             VALUES ($1, $2, $3, (SELECT COALESCE(MAX(ordem), 0) + 1 FROM financas_categorias WHERE tipo = $4)) \
             RETURNING {CATEGORIA_COLUMNS}"
        ))
        .bind(id.db())
        .bind(&nome)
        .bind(tipo)
        .bind(tipo)
        .fetch_one(&self.pool)
        .await
        .map_err(|err| conflito_ou_banco(err, || format!("já existe uma categoria chamada {nome:?}")))
    }

    // -----------------------------------------------------------------------
    // Recorrentes e vigências
    // -----------------------------------------------------------------------

    /// `criar_recorrente`: o recorrente e sua primeira vigência (aberta a
    /// partir de `inicio_mes`) numa transação só — um recorrente sem vigência
    /// nunca fica visível.
    pub async fn criar_recorrente(
        &self,
        descricao: &str,
        tipo: &str,
        categoria_id: Option<Uuid>,
        valor_centavos: i64,
        inicio_mes: &str,
    ) -> Result<RecorrenteComVigencias> {
        let descricao = validar_texto(descricao, "descrição")?;
        validar_tipo(tipo)?;
        validar_valor_centavos(valor_centavos)?;
        parse_mes(inicio_mes)?;

        let id = Uuid::now_v7();
        let mut tx = self.pool.begin().await?;

        sqlx::query("INSERT INTO financas_recorrentes (id, descricao, tipo, categoria_id) VALUES ($1, $2, $3, $4)")
            .bind(id.db())
            .bind(&descricao)
            .bind(tipo)
            .bind(categoria_id.db())
            .execute(&mut *tx)
            .await?;
        inserir_vigencia(&mut tx, id, valor_centavos, inicio_mes).await?;

        let criado = carregar_recorrente(&mut tx, id).await?;
        tx.commit().await?;
        Ok(criado)
    }

    /// `listar_recorrentes`: todos, inclusive os encerrados (a tela decide o
    /// que mostrar a partir das vigências).
    pub async fn listar_recorrentes(&self) -> Result<Vec<RecorrenteComVigencias>> {
        let recorrentes: Vec<RecorrenteRow> = sqlx::query_as(&format!(
            "SELECT {RECORRENTE_COLUMNS} FROM financas_recorrentes ORDER BY tipo, descricao, created_at"
        ))
        .fetch_all(&self.pool)
        .await?;

        let vigencias: Vec<VigenciaRow> = sqlx::query_as(&format!(
            "SELECT {VIGENCIA_COLUMNS} FROM financas_vigencias ORDER BY recorrente_id, inicio_mes"
        ))
        .fetch_all(&self.pool)
        .await?;

        let mut por_recorrente: HashMap<Uuid, Vec<VigenciaRow>> = HashMap::new();
        for vigencia in vigencias {
            por_recorrente.entry(vigencia.recorrente_id).or_default().push(vigencia);
        }

        Ok(recorrentes
            .into_iter()
            .map(|recorrente| {
                let vigencias = por_recorrente.remove(&recorrente.id).unwrap_or_default();
                RecorrenteComVigencias { recorrente, vigencias }
            })
            .collect())
    }

    /// `atualizar_recorrente`. Não toca lançamentos já confirmados: eles são
    /// o registro do que aconteceu.
    pub async fn atualizar_recorrente(&self, id: Uuid, patch: RecorrentePatchInput) -> Result<RecorrenteRow> {
        let descricao = patch.descricao.as_deref().map(|d| validar_texto(d, "descrição")).transpose()?;
        if let Some(tipo) = patch.tipo.as_deref() {
            validar_tipo(tipo)?;
        }

        sqlx::query_as::<_, RecorrenteRow>(&format!(
            "UPDATE financas_recorrentes SET \
                 descricao = COALESCE($2, descricao), \
                 tipo = COALESCE($3, tipo), \
                 categoria_id = COALESCE($4, categoria_id) \
             WHERE id = $1 RETURNING {RECORRENTE_COLUMNS}"
        ))
        .bind(id.db())
        .bind(&descricao)
        .bind(&patch.tipo)
        .bind(patch.categoria_id.db())
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("recorrente {id}")))
    }

    /// `remover_recorrente`. Vigências vão junto (CASCADE); lançamentos já
    /// confirmados ficam, com `recorrente_id` nulo (SET NULL) — o dinheiro que
    /// saiu continua no realizado.
    pub async fn remover_recorrente(&self, id: Uuid) -> Result<()> {
        let result =
            sqlx::query("DELETE FROM financas_recorrentes WHERE id = $1").bind(id.db()).execute(&self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("recorrente {id}")));
        }
        Ok(())
    }

    /// `mudar_valor_recorrente`: `valor_centavos` vale de `mes` em diante,
    /// aberto. Numa transação:
    ///
    /// 1. vigências que começam DEPOIS de `mes` são apagadas;
    /// 2. a vigência que começou ANTES e ainda cobre `mes` é fechada no mês
    ///    anterior;
    /// 3. a vigência que começa exatamente em `mes`, se houver, recebe o valor
    ///    e fica aberta; senão, cria-se uma nova.
    ///
    /// O resultado nunca tem duas vigências cobrindo o mesmo mês.
    pub async fn mudar_valor_a_partir_de(
        &self,
        recorrente_id: Uuid,
        valor_centavos: i64,
        mes: &str,
    ) -> Result<RecorrenteComVigencias> {
        validar_valor_centavos(valor_centavos)?;
        let anterior = mes_anterior(mes)?;

        let mut tx = self.pool.begin().await?;
        garantir_recorrente_existe(&mut tx, recorrente_id).await?;

        sqlx::query("DELETE FROM financas_vigencias WHERE recorrente_id = $1 AND inicio_mes > $2")
            .bind(recorrente_id.db())
            .bind(mes)
            .execute(&mut *tx)
            .await?;

        sqlx::query(
            "UPDATE financas_vigencias SET fim_mes = $1 \
             WHERE recorrente_id = $2 AND inicio_mes < $3 AND (fim_mes IS NULL OR fim_mes >= $4)",
        )
        .bind(&anterior)
        .bind(recorrente_id.db())
        .bind(mes)
        .bind(mes)
        .execute(&mut *tx)
        .await?;

        let mesma_data = sqlx::query(
            "UPDATE financas_vigencias SET valor_centavos = $1, fim_mes = NULL \
             WHERE recorrente_id = $2 AND inicio_mes = $3",
        )
        .bind(valor_centavos)
        .bind(recorrente_id.db())
        .bind(mes)
        .execute(&mut *tx)
        .await?;

        if mesma_data.rows_affected() == 0 {
            inserir_vigencia(&mut tx, recorrente_id, valor_centavos, mes).await?;
        }

        let atualizado = carregar_recorrente(&mut tx, recorrente_id).await?;
        tx.commit().await?;
        Ok(atualizado)
    }

    /// `encerrar_recorrente`: `ultimo_mes` é o último mês que ainda prevê
    /// (fim INCLUSIVO). Vigências que começariam depois são apagadas.
    /// `Error::Invalid` se nenhuma vigência cobre `ultimo_mes`.
    pub async fn encerrar_recorrente(&self, recorrente_id: Uuid, ultimo_mes: &str) -> Result<RecorrenteComVigencias> {
        parse_mes(ultimo_mes)?;

        let mut tx = self.pool.begin().await?;
        garantir_recorrente_existe(&mut tx, recorrente_id).await?;

        let fechada = sqlx::query(
            "UPDATE financas_vigencias SET fim_mes = $1 \
             WHERE recorrente_id = $2 AND inicio_mes <= $3 AND (fim_mes IS NULL OR fim_mes >= $4)",
        )
        .bind(ultimo_mes)
        .bind(recorrente_id.db())
        .bind(ultimo_mes)
        .bind(ultimo_mes)
        .execute(&mut *tx)
        .await?;

        if fechada.rows_affected() == 0 {
            return Err(Error::Invalid(format!("o recorrente não está vigente em {ultimo_mes}")));
        }

        sqlx::query("DELETE FROM financas_vigencias WHERE recorrente_id = $1 AND inicio_mes > $2")
            .bind(recorrente_id.db())
            .bind(ultimo_mes)
            .execute(&mut *tx)
            .await?;

        let encerrado = carregar_recorrente(&mut tx, recorrente_id).await?;
        tx.commit().await?;
        Ok(encerrado)
    }

    /// `confirmar_recorrente`: grava o lançamento do fixo no mês.
    ///
    /// - `valor_centavos` ausente = o valor vigente no mês;
    /// - `data_local` ausente = dia 1 do mês;
    /// - descrição, tipo e categoria vêm do recorrente.
    ///
    /// `Error::Invalid` se o recorrente não está vigente em `mes` (mesmo com
    /// valor informado: o fixo não apareceria no resumo daquele mês) ou se já
    /// foi confirmado nele.
    pub async fn confirmar_recorrente(
        &self,
        recorrente_id: Uuid,
        mes: &str,
        valor_centavos: Option<i64>,
        data_local: Option<&str>,
    ) -> Result<LancamentoRow> {
        parse_mes(mes)?;
        if let Some(valor) = valor_centavos {
            validar_valor_centavos(valor)?;
        }
        let data_local = match data_local {
            Some(data) => {
                validar_data_local(data)?;
                data.to_string()
            }
            None => format!("{mes}-01"),
        };

        let mut conn = self.pool.acquire().await?;
        let recorrente = carregar_recorrente(&mut conn, recorrente_id).await?;
        let vigente = valor_vigente(&recorrente.vigencias, mes)
            .ok_or_else(|| Error::Invalid(format!("o recorrente não está vigente em {mes}")))?;
        let valor = valor_centavos.unwrap_or(vigente);

        let id = Uuid::now_v7();
        let descricao = recorrente.recorrente.descricao.clone();
        sqlx::query_as::<_, LancamentoRow>(&format!(
            "INSERT INTO financas_lancamentos \
                 (id, data_local, descricao, tipo, categoria_id, valor_centavos, recorrente_id, mes_referencia) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {LANCAMENTO_COLUMNS}"
        ))
        .bind(id.db())
        .bind(&data_local)
        .bind(&descricao)
        .bind(&recorrente.recorrente.tipo)
        .bind(recorrente.recorrente.categoria_id.db())
        .bind(valor)
        .bind(recorrente_id.db())
        .bind(mes)
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| conflito_ou_banco(err, || format!("{descricao:?} já foi confirmado em {mes}")))
    }

    // -----------------------------------------------------------------------
    // Lançamentos
    // -----------------------------------------------------------------------

    /// `criar_lancamento` (avulso). `categoriaId` inexistente surge como
    /// `Error::Database` (FK) — mesma escolha de `PrazoRepository::criar`.
    pub async fn criar_lancamento(
        &self,
        data_local: &str,
        descricao: &str,
        tipo: &str,
        categoria_id: Option<Uuid>,
        valor_centavos: i64,
    ) -> Result<LancamentoRow> {
        validar_data_local(data_local)?;
        let descricao = validar_texto(descricao, "descrição")?;
        validar_tipo(tipo)?;
        validar_valor_centavos(valor_centavos)?;

        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, LancamentoRow>(&format!(
            "INSERT INTO financas_lancamentos (id, data_local, descricao, tipo, categoria_id, valor_centavos) \
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING {LANCAMENTO_COLUMNS}"
        ))
        .bind(id.db())
        .bind(data_local)
        .bind(&descricao)
        .bind(tipo)
        .bind(categoria_id.db())
        .bind(valor_centavos)
        .fetch_one(&self.pool)
        .await?;
        Ok(row)
    }

    /// `atualizar_lancamento`. Patch por `COALESCE`.
    pub async fn atualizar_lancamento(&self, id: Uuid, patch: LancamentoPatchInput) -> Result<LancamentoRow> {
        if let Some(data) = patch.data_local.as_deref() {
            validar_data_local(data)?;
        }
        let descricao = patch.descricao.as_deref().map(|d| validar_texto(d, "descrição")).transpose()?;
        if let Some(tipo) = patch.tipo.as_deref() {
            validar_tipo(tipo)?;
        }
        if let Some(valor) = patch.valor_centavos {
            validar_valor_centavos(valor)?;
        }

        sqlx::query_as::<_, LancamentoRow>(&format!(
            "UPDATE financas_lancamentos SET \
                 data_local = COALESCE($2, data_local), \
                 descricao = COALESCE($3, descricao), \
                 tipo = COALESCE($4, tipo), \
                 categoria_id = COALESCE($5, categoria_id), \
                 valor_centavos = COALESCE($6, valor_centavos) \
             WHERE id = $1 RETURNING {LANCAMENTO_COLUMNS}"
        ))
        .bind(id.db())
        .bind(&patch.data_local)
        .bind(&descricao)
        .bind(&patch.tipo)
        .bind(patch.categoria_id.db())
        .bind(patch.valor_centavos)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("lançamento {id}")))
    }

    /// `remover_lancamento`. Remover a confirmação de um fixo o devolve a
    /// pendente naquele mês.
    pub async fn remover_lancamento(&self, id: Uuid) -> Result<()> {
        let result =
            sqlx::query("DELETE FROM financas_lancamentos WHERE id = $1").bind(id.db()).execute(&self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("lançamento {id}")));
        }
        Ok(())
    }

    /// `listar_lancamentos_do_mes`: pela `data_local`, em ordem de dia e de
    /// criação.
    pub async fn listar_lancamentos_do_mes(&self, mes: &str) -> Result<Vec<LancamentoRow>> {
        let (inicio, fim_exclusivo) = limites_do_mes(mes)?;
        let rows = sqlx::query_as::<_, LancamentoRow>(&format!(
            "SELECT {LANCAMENTO_COLUMNS} FROM financas_lancamentos \
             WHERE data_local >= $1 AND data_local < $2 ORDER BY data_local, created_at"
        ))
        .bind(&inicio)
        .bind(&fim_exclusivo)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    // -----------------------------------------------------------------------
    // Resumos
    // -----------------------------------------------------------------------

    /// `resumo_financeiro_do_mes`. Regras em [`ResumoDoMes`].
    pub async fn resumo_do_mes(&self, mes: &str) -> Result<ResumoDoMes> {
        let (inicio, fim_exclusivo) = limites_do_mes(mes)?;
        let recorrentes = self.listar_recorrentes().await?;
        let lancamentos = self.listar_lancamentos_do_mes(mes).await?;

        // Confirmação é por `mes_referencia`, não por `data_local`: o aluguel
        // de setembro pago em 2 de outubro continua sendo o de setembro.
        let confirmados: Vec<LancamentoRow> = sqlx::query_as(&format!(
            "SELECT {LANCAMENTO_COLUMNS} FROM financas_lancamentos \
             WHERE recorrente_id IS NOT NULL AND mes_referencia = $1"
        ))
        .bind(mes)
        .fetch_all(&self.pool)
        .await?;
        let confirmado_por_recorrente: HashMap<Uuid, &LancamentoRow> = confirmados
            .iter()
            .filter_map(|lancamento| lancamento.recorrente_id.map(|rid| (rid, lancamento)))
            .collect();

        let mut previstas = Totais::default();
        let mut realizadas = Totais::default();
        let mut fixos = Vec::new();

        for item in &recorrentes {
            let Some(valor_previsto) = valor_vigente(&item.vigencias, mes) else {
                continue;
            };
            previstas.somar(&item.recorrente.tipo, valor_previsto)?;
            let confirmado = confirmado_por_recorrente.get(&item.recorrente.id);
            fixos.push(FixoDoMes {
                recorrente_id: item.recorrente.id,
                descricao: item.recorrente.descricao.clone(),
                tipo: item.recorrente.tipo.clone(),
                categoria_id: item.recorrente.categoria_id,
                valor_previsto_centavos: valor_previsto,
                lancamento_id: confirmado.map(|l| l.id),
                valor_confirmado_centavos: confirmado.map(|l| l.valor_centavos),
            });
        }

        for lancamento in &lancamentos {
            if lancamento.recorrente_id.is_none() {
                previstas.somar(&lancamento.tipo, lancamento.valor_centavos)?;
            }
            realizadas.somar(&lancamento.tipo, lancamento.valor_centavos)?;
        }

        let por_categoria: Vec<GastoPorCategoria> = sqlx::query_as(
            "SELECT l.categoria_id AS categoria_id, c.nome AS nome, SUM(l.valor_centavos) AS saidas_centavos \
             FROM financas_lancamentos l \
             LEFT JOIN financas_categorias c ON c.id = l.categoria_id \
             WHERE l.tipo = 'saida' AND l.data_local >= $1 AND l.data_local < $2 \
             GROUP BY l.categoria_id, c.nome \
             ORDER BY saidas_centavos DESC, c.nome",
        )
        .bind(&inicio)
        .bind(&fim_exclusivo)
        .fetch_all(&self.pool)
        .await?;

        Ok(ResumoDoMes {
            mes: mes.to_string(),
            entradas_previstas: previstas.entradas,
            saidas_previstas: previstas.saidas,
            entradas_realizadas: realizadas.entradas,
            saidas_realizadas: realizadas.saidas,
            sobra_prevista: previstas.sobra()?,
            sobra_realizada: realizadas.sobra()?,
            fixos,
            por_categoria,
        })
    }

    /// `visao_financeira_por_meses`: `quantidade` meses a partir de
    /// `inicio_mes` (inclusive). Reusa `resumo_do_mes` mês a mês — no máximo
    /// 36 rodadas, simples > uma consulta agregada.
    pub async fn visao_por_meses(&self, inicio_mes: &str, quantidade: i64) -> Result<Vec<LinhaDoMes>> {
        if !(1..=MAX_MESES_NA_VISAO).contains(&quantidade) {
            return Err(Error::Invalid(format!(
                "quantidade de meses inválida: {quantidade} (esperado de 1 a {MAX_MESES_NA_VISAO})"
            )));
        }
        parse_mes(inicio_mes)?;

        let mut linhas = Vec::new();
        let mut mes = inicio_mes.to_string();
        for indice in 0..quantidade {
            if indice > 0 {
                mes = mes_seguinte(&mes)?;
            }
            let resumo = self.resumo_do_mes(&mes).await?;
            linhas.push(LinhaDoMes::from(&resumo));
        }
        Ok(linhas)
    }
}

/// Acumulador de entradas/saídas com soma checada: um `+` puro estouraria em
/// silêncio em release, e aqui a entrada vem do banco.
#[derive(Default)]
struct Totais {
    entradas: i64,
    saidas: i64,
}

impl Totais {
    fn somar(&mut self, tipo: &str, valor: i64) -> Result<()> {
        let campo = match tipo {
            "entrada" => &mut self.entradas,
            "saida" => &mut self.saidas,
            outro => return Err(Error::Invalid(format!("tipo inválido no banco: {outro:?}"))),
        };
        *campo = campo.checked_add(valor).ok_or_else(|| Error::Invalid("soma de valores excede o limite".into()))?;
        Ok(())
    }

    fn sobra(&self) -> Result<i64> {
        self.entradas
            .checked_sub(self.saidas)
            .ok_or_else(|| Error::Invalid("diferença entre entradas e saídas excede o limite".into()))
    }
}

async fn garantir_recorrente_existe(conn: &mut SqliteConnection, id: Uuid) -> Result<()> {
    sqlx::query("SELECT 1 FROM financas_recorrentes WHERE id = $1")
        .bind(id.db())
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| Error::NotFound(format!("recorrente {id}")))?;
    Ok(())
}

async fn inserir_vigencia(conn: &mut SqliteConnection, recorrente_id: Uuid, valor_centavos: i64, inicio_mes: &str) -> Result<()> {
    sqlx::query("INSERT INTO financas_vigencias (id, recorrente_id, valor_centavos, inicio_mes) VALUES ($1, $2, $3, $4)")
        .bind(Uuid::now_v7().db())
        .bind(recorrente_id.db())
        .bind(valor_centavos)
        .bind(inicio_mes)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn carregar_recorrente(conn: &mut SqliteConnection, id: Uuid) -> Result<RecorrenteComVigencias> {
    let recorrente = sqlx::query_as::<_, RecorrenteRow>(&format!(
        "SELECT {RECORRENTE_COLUMNS} FROM financas_recorrentes WHERE id = $1"
    ))
    .bind(id.db())
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| Error::NotFound(format!("recorrente {id}")))?;

    let vigencias = sqlx::query_as::<_, VigenciaRow>(&format!(
        "SELECT {VIGENCIA_COLUMNS} FROM financas_vigencias WHERE recorrente_id = $1 ORDER BY inicio_mes"
    ))
    .bind(id.db())
    .fetch_all(&mut *conn)
    .await?;

    Ok(RecorrenteComVigencias { recorrente, vigencias })
}

/// Violação de `UNIQUE` vira `Error::Invalid` com mensagem legível; qualquer
/// outro erro de banco segue como `Error::Database`.
fn conflito_ou_banco(err: sqlx::Error, mensagem: impl FnOnce() -> String) -> Error {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err.is_unique_violation() {
            return Error::Invalid(mensagem());
        }
    }
    Error::Database(err)
}

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------

/// Pura: valida `YYYY-MM` (4 dígitos, hífen, 2 dígitos, mês 1..=12) e devolve
/// `(ano, mes)`.
pub fn parse_mes(mes: &str) -> Result<(i32, u32)> {
    let invalido = || Error::Invalid(format!("mês inválido: {mes:?} (esperado AAAA-MM)"));
    let bytes = mes.as_bytes();
    let formato_ok = bytes.len() == 7
        && bytes.iter().enumerate().all(|(posicao, byte)| if posicao == 4 { *byte == b'-' } else { byte.is_ascii_digit() });
    if !formato_ok {
        return Err(invalido());
    }
    let ano: i32 = mes.get(0..4).and_then(|s| s.parse().ok()).ok_or_else(invalido)?;
    let numero: u32 = mes.get(5..7).and_then(|s| s.parse().ok()).ok_or_else(invalido)?;
    if !(1..=12).contains(&numero) {
        return Err(invalido());
    }
    Ok((ano, numero))
}

fn formatar_mes(ano: i32, mes: u32, origem: &str) -> Result<String> {
    if !(0..=9999).contains(&ano) {
        return Err(Error::Invalid(format!("mês fora do intervalo suportado a partir de {origem:?}")));
    }
    Ok(format!("{ano:04}-{mes:02}"))
}

/// Pura: o mês seguinte (`2026-12` -> `2027-01`). `Error::Invalid` para
/// entrada malformada ou para além de `9999-12`.
pub fn mes_seguinte(mes: &str) -> Result<String> {
    let (ano, numero) = parse_mes(mes)?;
    // `ano` tem 4 dígitos (<= 9999), então `+ 1` não estoura `i32`.
    if numero == 12 { formatar_mes(ano + 1, 1, mes) } else { formatar_mes(ano, numero + 1, mes) }
}

/// Pura: o mês anterior (`2027-01` -> `2026-12`). `Error::Invalid` para
/// entrada malformada ou antes de `0000-01`.
pub fn mes_anterior(mes: &str) -> Result<String> {
    let (ano, numero) = parse_mes(mes)?;
    // `ano` >= 0 (4 dígitos), então `- 1` não estoura `i32`.
    if numero == 1 { formatar_mes(ano - 1, 12, mes) } else { formatar_mes(ano, numero - 1, mes) }
}

/// Pura: `(primeiro dia do mês, primeiro dia do mês seguinte)` como
/// `YYYY-MM-DD`, para filtrar `data_local >= inicio AND data_local < fim` por
/// comparação de texto (largura fixa = ordem cronológica).
pub fn limites_do_mes(mes: &str) -> Result<(String, String)> {
    parse_mes(mes)?;
    let seguinte = mes_seguinte(mes)?;
    Ok((format!("{mes}-01"), format!("{seguinte}-01")))
}

/// Pura: o valor vigente em `mes` (`inicio_mes <= mes <= fim_mes`, fim
/// inclusivo e `None` = aberto), ou `None` se nenhuma vigência cobre. Se dados
/// inconsistentes tiverem duas vigências cobrindo o mês, vale a de início mais
/// recente. Espera `mes` já validado: compara texto de largura fixa.
pub fn valor_vigente(vigencias: &[VigenciaRow], mes: &str) -> Option<i64> {
    vigencias
        .iter()
        .filter(|v| v.inicio_mes.as_str() <= mes && v.fim_mes.as_deref().is_none_or(|fim| mes <= fim))
        .max_by(|a, b| a.inicio_mes.cmp(&b.inicio_mes))
        .map(|v| v.valor_centavos)
}

/// Pura: `0 <= valor <= TETO_VALOR_CENTAVOS`.
pub fn validar_valor_centavos(valor_centavos: i64) -> Result<i64> {
    if !(0..=TETO_VALOR_CENTAVOS).contains(&valor_centavos) {
        return Err(Error::Invalid(format!(
            "valor inválido: {valor_centavos} centavos (esperado de 0 a {TETO_VALOR_CENTAVOS})"
        )));
    }
    Ok(valor_centavos)
}

/// `YYYY-MM-DD` real (chrono recusa 2026-02-30) e na forma canônica: o
/// `%m`/`%d` do chrono aceitaria `2026-9-5`, que a `GLOB` da migração
/// recusaria como `Error::Database`.
fn validar_data_local(raw: &str) -> Result<NaiveDate> {
    let invalida = || Error::Invalid(format!("data inválida: {raw:?} (esperado AAAA-MM-DD)"));
    let data = NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| invalida())?;
    if data.format("%Y-%m-%d").to_string() != raw {
        return Err(invalida());
    }
    Ok(data)
}

fn validar_tipo(tipo: &str) -> Result<()> {
    if !TIPOS_VALIDOS.contains(&tipo) {
        return Err(Error::Invalid(format!("tipo inválido: {tipo:?} (esperado um de {TIPOS_VALIDOS:?})")));
    }
    Ok(())
}

fn validar_texto(texto: &str, campo: &str) -> Result<String> {
    let trimmed = texto.trim();
    if trimmed.is_empty() {
        return Err(Error::Invalid(format!("{campo} não pode ser vazio")));
    }
    if trimmed.chars().count() > MAX_TEXTO_CHARS {
        return Err(Error::Invalid(format!("{campo} maior que {MAX_TEXTO_CHARS} caracteres")));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn vigencia(inicio: &str, fim: Option<&str>, valor: i64) -> VigenciaRow {
        VigenciaRow {
            id: Uuid::now_v7(),
            recorrente_id: Uuid::nil(),
            valor_centavos: valor,
            inicio_mes: inicio.to_string(),
            fim_mes: fim.map(str::to_string),
            created_at: Utc::now(),
        }
    }

    #[test]
    fn parse_mes_aceita_formato_valido() {
        assert_eq!(parse_mes("2026-09").unwrap(), (2026, 9));
        assert_eq!(parse_mes("2027-12").unwrap(), (2027, 12));
    }

    #[test]
    fn parse_mes_recusa_mes_fora_de_1_a_12_e_formato_torto() {
        for ruim in ["2026-13", "2026-00", "2026-9", "26-09", "", "2026/09", "2026-09-01", "abcd-ef", "２０２６-09"] {
            assert!(matches!(parse_mes(ruim), Err(Error::Invalid(_))), "deveria recusar {ruim:?}");
        }
    }

    #[test]
    fn mes_seguinte_e_anterior_atravessam_a_virada_de_ano() {
        assert_eq!(mes_seguinte("2026-12").unwrap(), "2027-01");
        assert_eq!(mes_seguinte("2026-09").unwrap(), "2026-10");
        assert_eq!(mes_anterior("2027-01").unwrap(), "2026-12");
        assert_eq!(mes_anterior("2026-10").unwrap(), "2026-09");
    }

    #[test]
    fn mes_seguinte_e_anterior_recusam_a_borda_do_intervalo() {
        assert!(matches!(mes_seguinte("9999-12"), Err(Error::Invalid(_))));
        assert!(matches!(mes_anterior("0000-01"), Err(Error::Invalid(_))));
        assert!(matches!(mes_seguinte("2026-13"), Err(Error::Invalid(_))));
    }

    #[test]
    fn limites_do_mes_usa_o_primeiro_dia_do_mes_seguinte() {
        assert_eq!(limites_do_mes("2026-09").unwrap(), ("2026-09-01".to_string(), "2026-10-01".to_string()));
        assert_eq!(limites_do_mes("2026-12").unwrap(), ("2026-12-01".to_string(), "2027-01-01".to_string()));
    }

    #[test]
    fn valor_vigente_respeita_inicio_e_fim_inclusivos() {
        let vigencias = [vigencia("2026-01", Some("2026-12"), 100), vigencia("2027-01", None, 200)];
        assert_eq!(valor_vigente(&vigencias, "2025-12"), None);
        assert_eq!(valor_vigente(&vigencias, "2026-01"), Some(100));
        assert_eq!(valor_vigente(&vigencias, "2026-12"), Some(100));
        assert_eq!(valor_vigente(&vigencias, "2027-01"), Some(200));
        assert_eq!(valor_vigente(&vigencias, "2099-05"), Some(200));
    }

    #[test]
    fn valor_vigente_de_lista_vazia_e_none() {
        assert_eq!(valor_vigente(&[], "2026-09"), None);
    }

    #[test]
    fn validar_valor_centavos_recusa_negativo_e_acima_do_teto() {
        assert_eq!(validar_valor_centavos(0).unwrap(), 0);
        assert_eq!(validar_valor_centavos(TETO_VALOR_CENTAVOS).unwrap(), TETO_VALOR_CENTAVOS);
        assert!(matches!(validar_valor_centavos(-1), Err(Error::Invalid(_))));
        assert!(matches!(validar_valor_centavos(TETO_VALOR_CENTAVOS + 1), Err(Error::Invalid(_))));
        assert!(matches!(validar_valor_centavos(i64::MIN), Err(Error::Invalid(_))));
    }

    #[test]
    fn validar_data_local_exige_data_real_e_canonica() {
        assert!(validar_data_local("2026-09-30").is_ok());
        assert!(validar_data_local("2028-02-29").is_ok());
        assert!(validar_data_local("2026-02-30").is_err());
        assert!(validar_data_local("2026-9-5").is_err());
        assert!(validar_data_local("").is_err());
    }

    #[test]
    fn validar_tipo_e_texto() {
        assert!(validar_tipo("entrada").is_ok());
        assert!(validar_tipo("saida").is_ok());
        assert!(matches!(validar_tipo("saída"), Err(Error::Invalid(_))));
        assert_eq!(validar_texto("  Aluguel  ", "descrição").unwrap(), "Aluguel");
        assert!(matches!(validar_texto("   ", "descrição"), Err(Error::Invalid(_))));
        assert!(matches!(validar_texto(&"x".repeat(MAX_TEXTO_CHARS + 1), "descrição"), Err(Error::Invalid(_))));
    }

    #[test]
    fn totais_somam_checado_e_recusam_tipo_desconhecido() {
        let mut totais = Totais::default();
        totais.somar("entrada", 500).unwrap();
        totais.somar("saida", 800).unwrap();
        assert_eq!(totais.sobra().unwrap(), -300);
        assert!(matches!(totais.somar("outro", 1), Err(Error::Invalid(_))));
        totais.somar("entrada", i64::MAX - 500).unwrap();
        assert!(matches!(totais.somar("entrada", 1), Err(Error::Invalid(_))));
    }
}
