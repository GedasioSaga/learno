//! Ler a coleção SQLite do Anki já extraída por [`super::abrir_pacote`].
//!
//! Dois schemas. O novo (15 em diante) tem tabelas `notetypes`, `fields`,
//! `templates` e `decks`, com configuração em protobuf. O antigo (11) guarda
//! tipos de nota e baralhos em JSON dentro de `col`. Notas, cartões e
//! revisões têm as mesmas colunas nos dois.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, SqliteConnection};

use super::proto;
use crate::error::{Error, Result};

/// Separa os campos em `notes.flds` e os níveis em `decks.name` (schema novo).
const SEPARADOR: char = '\u{1f}';

#[derive(Debug, Clone, PartialEq)]
pub struct ColecaoAnki {
    /// Criação da coleção, em segundos desde epoch. O vencimento de um cartão
    /// em revisão é um número de DIAS contado a partir daqui.
    pub criada_em: i64,
    pub tipos_de_nota: Vec<TipoDeNotaAnki>,
    pub baralhos: Vec<BaralhoAnki>,
    pub notas: Vec<NotaAnki>,
    pub cartoes: Vec<CartaoAnki>,
    pub revisoes: Vec<RevisaoAnki>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TipoDeNotaAnki {
    pub id: i64,
    pub nome: String,
    pub cloze: bool,
    pub campos: Vec<String>,
    pub templates: Vec<TemplateAnki>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateAnki {
    pub nome: String,
    pub frente: String,
    pub verso: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaralhoAnki {
    pub id: i64,
    /// Níveis da hierarquia: "Medicina::Rim" vira `["Medicina", "Rim"]`.
    pub caminho: Vec<String>,
    pub filtrado: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotaAnki {
    pub id: i64,
    pub guid: String,
    pub tipo_de_nota_id: i64,
    pub tags: Vec<String>,
    /// HTML cru, na ordem dos campos do tipo de nota.
    pub campos: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CartaoAnki {
    pub id: i64,
    pub nota_id: i64,
    /// Já o baralho de ORIGEM quando o cartão está emprestado a um filtrado.
    pub baralho_id: i64,
    pub ordinal: i64,
    /// `cards.type`: 0 novo, 1 aprendendo, 2 revisão, 3 reaprendendo.
    pub tipo: i64,
    /// `cards.queue`: -1 suspenso, -2/-3 enterrado, 0 novo, 1/3 aprendendo,
    /// 2 revisão.
    pub fila: i64,
    /// Já o de origem para cartão em filtrado. Novo: posição na fila;
    /// aprendendo: epoch em segundos; revisão: dias desde `criada_em`.
    pub vencimento: i64,
    pub intervalo_dias: i64,
    /// Facilidade vezes 1000 (2500 = 250%).
    pub fator: i64,
    pub repeticoes: i64,
    pub lapsos: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisaoAnki {
    /// Milissegundos desde epoch: no Anki, o id É o instante da revisão.
    pub id: i64,
    pub cartao_id: i64,
    /// 1 a 4. Zero é reagendamento manual, não uma resposta.
    pub resposta: i64,
    /// Positivo = dias; negativo = segundos (passo de aprendizagem).
    pub intervalo: i64,
    pub intervalo_anterior: i64,
    /// Facilidade vezes 1000.
    pub fator: i64,
    pub duracao_ms: i64,
    /// 0 aprendizagem, 1 revisão, 2 reaprendizagem, 3 filtrado, 4 manual.
    pub tipo: i64,
}

pub async fn ler_colecao(arquivo: &Path) -> Result<ColecaoAnki> {
    let mut conexao = SqliteConnectOptions::new()
        .filename(arquivo)
        .read_only(true)
        // O Anki declara colunas e índices com a collation `unicase`, que só
        // existe dentro dele. Numa coleção real, `count(*)` em `decks` falhou
        // com "no such collation sequence" porque o planejador escolheu o
        // índice por nome. As consultas daqui ordenam por id e não dependem
        // desses índices, mas o planejador decide sozinho (as coleções trazem
        // `sqlite_stat4`); registrar a collation tira a escolha dele do caminho.
        .collation("unicase", comparar_sem_caixa)
        .connect()
        .await
        .map_err(colecao_invalida)?;

    let resultado = ler(&mut conexao).await;
    let _ = conexao.close().await;
    resultado
}

async fn ler(conexao: &mut SqliteConnection) -> Result<ColecaoAnki> {
    let criada_em: i64 =
        sqlx::query_scalar("SELECT crt FROM col").fetch_one(&mut *conexao).await.map_err(colecao_invalida)?;
    let schema_novo: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notetypes')")
            .fetch_one(&mut *conexao)
            .await
            .map_err(colecao_invalida)?;

    let (tipos_de_nota, baralhos) = if schema_novo {
        (tipos_schema_novo(conexao).await?, baralhos_schema_novo(conexao).await?)
    } else {
        configuracao_schema_antigo(conexao).await?
    };

    Ok(ColecaoAnki {
        criada_em,
        tipos_de_nota,
        baralhos,
        notas: notas(conexao).await?,
        cartoes: cartoes(conexao).await?,
        revisoes: revisoes(conexao).await?,
    })
}

async fn tipos_schema_novo(conexao: &mut SqliteConnection) -> Result<Vec<TipoDeNotaAnki>> {
    let mut campos: HashMap<i64, Vec<String>> = HashMap::new();
    for (tipo, nome) in sqlx::query_as::<_, (i64, String)>("SELECT ntid, name FROM fields ORDER BY ntid, ord")
        .fetch_all(&mut *conexao)
        .await
        .map_err(colecao_invalida)?
    {
        campos.entry(tipo).or_default().push(nome);
    }

    let mut templates: HashMap<i64, Vec<TemplateAnki>> = HashMap::new();
    for (tipo, nome, config) in
        sqlx::query_as::<_, (i64, String, Vec<u8>)>("SELECT ntid, name, config FROM templates ORDER BY ntid, ord")
            .fetch_all(&mut *conexao)
            .await
            .map_err(colecao_invalida)?
    {
        templates.entry(tipo).or_default().push(TemplateAnki {
            nome,
            frente: proto::texto(&config, 1)?.unwrap_or_default(),
            verso: proto::texto(&config, 2)?.unwrap_or_default(),
        });
    }

    let linhas = sqlx::query_as::<_, (i64, String, Vec<u8>)>("SELECT id, name, config FROM notetypes ORDER BY id")
        .fetch_all(&mut *conexao)
        .await
        .map_err(colecao_invalida)?;
    let mut tipos = Vec::with_capacity(linhas.len());
    for (id, nome, config) in linhas {
        tipos.push(TipoDeNotaAnki {
            id,
            nome,
            cloze: proto::varint(&config, 1)? == Some(1),
            campos: campos.remove(&id).unwrap_or_default(),
            templates: templates.remove(&id).unwrap_or_default(),
        });
    }
    Ok(tipos)
}

async fn baralhos_schema_novo(conexao: &mut SqliteConnection) -> Result<Vec<BaralhoAnki>> {
    sqlx::query_as::<_, (i64, String, Vec<u8>)>("SELECT id, name, kind FROM decks ORDER BY id")
        .fetch_all(&mut *conexao)
        .await
        .map_err(colecao_invalida)?
        .into_iter()
        .map(|(id, nome, kind)| {
            Ok(BaralhoAnki { id, caminho: dividir_caminho(&nome), filtrado: proto::tem_campo(&kind, 2)? })
        })
        .collect()
}

#[derive(Deserialize)]
struct ModeloAntigo {
    name: String,
    #[serde(rename = "type", default)]
    tipo: i64,
    flds: Vec<CampoAntigo>,
    tmpls: Vec<TemplateAntigo>,
}

#[derive(Deserialize)]
struct CampoAntigo {
    name: String,
    ord: i64,
}

#[derive(Deserialize)]
struct TemplateAntigo {
    name: String,
    ord: i64,
    qfmt: String,
    afmt: String,
}

#[derive(Deserialize)]
struct BaralhoAntigo {
    name: String,
    /// 0/1 na maioria das versões, booleano em algumas.
    #[serde(rename = "dyn", default)]
    filtrado: serde_json::Value,
}

async fn configuracao_schema_antigo(
    conexao: &mut SqliteConnection,
) -> Result<(Vec<TipoDeNotaAnki>, Vec<BaralhoAnki>)> {
    let (modelos, baralhos): (String, String) = sqlx::query_as("SELECT models, decks FROM col")
        .fetch_one(&mut *conexao)
        .await
        .map_err(colecao_invalida)?;
    let modelos: HashMap<String, ModeloAntigo> = serde_json::from_str(&modelos).map_err(json_invalido)?;
    let baralhos: HashMap<String, BaralhoAntigo> = serde_json::from_str(&baralhos).map_err(json_invalido)?;

    let mut tipos = modelos
        .into_iter()
        .map(|(id, mut modelo)| {
            modelo.flds.sort_by_key(|campo| campo.ord);
            modelo.tmpls.sort_by_key(|template| template.ord);
            Ok(TipoDeNotaAnki {
                id: id_da_chave(&id)?,
                nome: modelo.name,
                cloze: modelo.tipo == 1,
                campos: modelo.flds.into_iter().map(|campo| campo.name).collect(),
                templates: modelo
                    .tmpls
                    .into_iter()
                    .map(|t| TemplateAnki { nome: t.name, frente: t.qfmt, verso: t.afmt })
                    .collect(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    tipos.sort_by_key(|tipo| tipo.id);

    let mut baralhos = baralhos
        .into_iter()
        .map(|(id, baralho)| {
            Ok(BaralhoAnki {
                id: id_da_chave(&id)?,
                caminho: dividir_caminho(&baralho.name),
                filtrado: baralho.filtrado.as_i64() == Some(1) || baralho.filtrado.as_bool() == Some(true),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    baralhos.sort_by_key(|baralho| baralho.id);

    Ok((tipos, baralhos))
}

async fn notas(conexao: &mut SqliteConnection) -> Result<Vec<NotaAnki>> {
    Ok(sqlx::query_as::<_, (i64, String, i64, String, String)>(
        "SELECT id, guid, mid, tags, flds FROM notes ORDER BY id",
    )
    .fetch_all(&mut *conexao)
    .await
    .map_err(colecao_invalida)?
    .into_iter()
    .map(|(id, guid, tipo_de_nota_id, tags, campos)| NotaAnki {
        id,
        guid,
        tipo_de_nota_id,
        tags: tags.split_whitespace().map(str::to_string).collect(),
        campos: campos.split(SEPARADOR).map(str::to_string).collect(),
    })
    .collect())
}

type LinhaDeCartao = (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64);

async fn cartoes(conexao: &mut SqliteConnection) -> Result<Vec<CartaoAnki>> {
    Ok(sqlx::query_as::<_, LinhaDeCartao>(
        "SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, odid, odue FROM cards ORDER BY id",
    )
    .fetch_all(&mut *conexao)
    .await
    .map_err(colecao_invalida)?
    .into_iter()
    .map(|(id, nota_id, baralho, ordinal, tipo, fila, due, intervalo, fator, repeticoes, lapsos, origem, due_origem)| {
        // Cartão emprestado a um baralho filtrado volta para o de origem: um
        // filtrado é uma busca temporária, não um lugar onde o cartão mora.
        let emprestado = origem != 0;
        CartaoAnki {
            id,
            nota_id,
            baralho_id: if emprestado { origem } else { baralho },
            ordinal,
            tipo,
            fila,
            vencimento: if emprestado && due_origem != 0 { due_origem } else { due },
            intervalo_dias: intervalo,
            fator,
            repeticoes,
            lapsos,
        }
    })
    .collect())
}

async fn revisoes(conexao: &mut SqliteConnection) -> Result<Vec<RevisaoAnki>> {
    Ok(sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64, i64, i64)>(
        "SELECT id, cid, ease, ivl, lastIvl, factor, time, type FROM revlog ORDER BY id",
    )
    .fetch_all(&mut *conexao)
    .await
    .map_err(colecao_invalida)?
    .into_iter()
    .map(|(id, cartao_id, resposta, intervalo, intervalo_anterior, fator, duracao_ms, tipo)| RevisaoAnki {
        id,
        cartao_id,
        resposta,
        intervalo,
        intervalo_anterior,
        fator,
        duracao_ms,
        tipo,
    })
    .collect())
}

/// "Medicina::Rim" (antigo) ou "Medicina\u{1f}Rim" (novo) -> `["Medicina", "Rim"]`.
fn dividir_caminho(nome: &str) -> Vec<String> {
    let niveis: Vec<&str> =
        if nome.contains(SEPARADOR) { nome.split(SEPARADOR).collect() } else { nome.split("::").collect() };
    niveis.into_iter().map(str::trim).filter(|nivel| !nivel.is_empty()).map(str::to_string).collect()
}

fn comparar_sem_caixa(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

fn id_da_chave(chave: &str) -> Result<i64> {
    chave.parse().map_err(|_| Error::Invalid(format!("coleção do Anki com id inválido: {chave:?}")))
}

fn colecao_invalida(erro: sqlx::Error) -> Error {
    Error::Invalid(format!("coleção do Anki ilegível: {erro}"))
}

fn json_invalido(erro: serde_json::Error) -> Error {
    Error::Invalid(format!("coleção do Anki com configuração corrompida: {erro}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn divide_caminho_nos_dois_formatos() {
        assert_eq!(dividir_caminho("Medicina::Rim"), vec!["Medicina", "Rim"]);
        assert_eq!(dividir_caminho("Medicina\u{1f}Rim\u{1f}Néfron"), vec!["Medicina", "Rim", "Néfron"]);
        assert_eq!(dividir_caminho("Default"), vec!["Default"]);
        assert_eq!(dividir_caminho(" A :: :: B "), vec!["A", "B"]);
    }
}
