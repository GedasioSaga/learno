//! Busca global (FUN-037) por título de página e conteúdo de bloco, sobre as
//! tabelas FTS5 de `0004_page_search.sql` e `0006_blocks.sql`.
//!
//! Repositório próprio, e não um método de `PageRepository`, de propósito: um
//! resultado é uma projeção feita para a paleta (qual página, qual trecho,
//! por que casou), nunca um `PageRow` inteiro.
//!
//! ## O que mudou na migração para SQLite, e o que se perdeu
//!
//! A versão Postgres somava duas coisas numa consulta só: `tsvector` com o
//! dicionário `portuguese` (que faz *stemming* — "correr" achava "correndo")
//! e `pg_trgm` (que fazia "Bio" achar "Biologia" por trigrama), tudo
//! embrulhado em `unaccent`.
//!
//! Aqui, `unicode61 remove_diacritics 2` do FTS5 dá a insensibilidade a
//! acento de graça, na criação da tabela — nenhuma normalização em tempo de
//! consulta. O casamento por começo de palavra vem do operador de prefixo do
//! próprio FTS5 (`"bio"*`), que é mais preciso que trigrama e não precisa de
//! extensão nenhuma.
//!
//! **A perda é o stemming**, e ela é real: `unicode61` não conhece radical de
//! português, então "correr" não acha mais "correndo". Está declarada em
//! `docs/MIGRACAO-SQLITE.md` e em `0015_global_search_accent_insensitive.sql`
//! para ser decidida depois, não escondida aqui.

use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::ids::DbId;
use crate::error::Result;

/// Quantas linhas a paleta mostra antes de truncar — o bastante para
/// percorrer com os olhos sem transformar "buscar" em "devolver tudo que
/// casa".
pub const DEFAULT_RESULT_LIMIT: i64 = 20;

/// Quantos caracteres do bloco viram trecho na paleta.
const SNIPPET_CHARS: i64 = 160;

/// Tetos do que uma consulta pode custar, e não são cosméticos: `search_pages`
/// é um comando de IPC, alcançável por qualquer script rodando na WebView, e a
/// consulta que ele monta faz varredura de prefixo nas duas tabelas FTS e
/// calcula `bm25` de tudo que casa antes de o `LIMIT` cortar. Sem teto, uma
/// chamada repetida com termo genérico custa CPU desproporcional ao que cabe
/// na tela. Os dois números são folgados para uso humano — ninguém digita 17
/// palavras numa paleta de busca — e apertados o bastante para o pior caso.
const MAX_TERMOS: usize = 16;
const MAX_CARACTERES_POR_TERMO: usize = 64;

/// Um acerto na paleta de busca. `rank` só ordena a lista que o backend já
/// devolveu — não significa nada sozinho, e o frontend nunca o recalcula nem
/// o compara entre buscas diferentes.
#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct SearchResultRow {
    #[sqlx(try_from = "DbId")]
    pub page_id: Uuid,
    pub page_title: String,
    pub snippet: String,
    /// `"title"` ou `"content"` — que campo casou, para a paleta rotular o
    /// acerto em vez de adivinhar pelo trecho.
    pub match_kind: String,
    pub rank: f64,
}

/// Título e conteúdo de bloco, título primeiro.
///
/// `-bm25(...)` porque o `bm25()` do FTS5 devolve número NEGATIVO e quanto
/// menor melhor (é uma distância, não uma pontuação); negar deixa "maior é
/// melhor", que é o que `ORDER BY rank DESC` e o nome do campo prometem. O
/// `CASE` antes dele é o que garante que título ganha de conteúdo: os dois
/// `bm25` vêm de tabelas FTS diferentes, com estatísticas próprias, então
/// compará-los diretamente entre si não teria significado — a comparação só
/// vale dentro de cada metade.
///
/// `deleted_at IS NULL` nos dois lados: uma página na lixeira não aparece na
/// busca, e um bloco de página viva mas ele mesmo apagado também não. O
/// índice FTS não sabe de lixeira — ele indexa tudo que existe —, então o
/// filtro é aqui, no join.
const SEARCH_SQL: &str = "\
    SELECT p.id AS page_id, p.title AS page_title, p.title AS snippet, 'title' AS match_kind, \
           -bm25(pages_fts) AS rank, 0 AS kind_order \
    FROM pages_fts JOIN pages p ON p.id = pages_fts.id \
    WHERE pages_fts MATCH ?1 AND p.deleted_at IS NULL \
    UNION ALL \
    SELECT b.page_id AS page_id, p.title AS page_title, substr(b.plain_text, 1, ?2) AS snippet, 'content' AS match_kind, \
           -bm25(blocks_fts) AS rank, 1 AS kind_order \
    FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.id JOIN pages p ON p.id = b.page_id \
    WHERE blocks_fts MATCH ?1 AND b.deleted_at IS NULL AND p.deleted_at IS NULL \
    ORDER BY kind_order, rank DESC \
    LIMIT ?3\
";

pub struct SearchRepository {
    pool: SqlitePool,
}

impl SearchRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// FUN-037. Entrada vazia ou só de espaço nunca chega ao banco: uma
    /// consulta FTS5 vazia é erro de sintaxe, não uma busca que não acha
    /// nada, então isso pularia direto para uma exceção na cara do usuário
    /// que só abriu a paleta e ainda não digitou.
    pub async fn search(&self, query: &str, limit: i64) -> Result<Vec<SearchResultRow>> {
        let Some(fts_query) = to_fts_query(query) else {
            return Ok(Vec::new());
        };

        let rows = sqlx::query_as::<_, SearchResultRow>(SEARCH_SQL)
            .bind(fts_query)
            .bind(SNIPPET_CHARS)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;

        Ok(rows)
    }
}

/// Traduz o que o usuário digitou para a linguagem de consulta do FTS5, ou
/// `None` quando não sobrou nada que valha uma ida ao banco.
///
/// Isto é código de segurança, não de conveniência. A linguagem do FTS5 tem
/// sintaxe própria — `"` delimita frase, `*` é prefixo, `:` prefixa nome de
/// coluna, `^` ancora, `-` nega, `AND`/`OR`/`NOT`/`NEAR` são operadores — e
/// ela NÃO é parametrizável: o texto todo entra por um bind só, e o módulo o
/// interpreta depois. Um título com dois-pontos (`"Aula 3: mitocôndria"`)
/// digitado cru vira `unrecognized token: ":"` na cara do usuário, e uma
/// entrada montada de propósito viraria uma consulta com outro significado.
/// Por isso a tradução aqui é por *lista de permissão*: cada palavra fica
/// reduzida a letras e dígitos, e é reemitida entre aspas, onde nada é
/// operador.
///
/// A última palavra ganha `*` — o operador de prefixo. É o que faz "Bio"
/// achar "Biologia" enquanto se digita, o mesmo comportamento que a versão
/// Postgres obtinha por trigrama. Só a última: as anteriores o usuário já
/// terminou de escrever.
fn to_fts_query(raw: &str) -> Option<String> {
    let mut palavras: Vec<String> = raw
        .split_whitespace()
        .map(|palavra| {
            palavra.chars().filter(|c| c.is_alphanumeric()).take(MAX_CARACTERES_POR_TERMO).collect::<String>()
        })
        .filter(|palavra| !palavra.is_empty())
        .collect();

    if palavras.is_empty() {
        return None;
    }

    palavras.truncate(MAX_TERMOS);

    let ultima = palavras.len() - 1;
    let termos: Vec<String> = palavras
        .iter()
        .enumerate()
        .map(|(i, palavra)| if i == ultima { format!("\"{palavra}\"*") } else { format!("\"{palavra}\"") })
        .collect();

    Some(termos.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consulta_em_branco_nao_vira_consulta_nenhuma() {
        assert_eq!(to_fts_query("   "), None);
        assert_eq!(to_fts_query(""), None);
    }

    #[test]
    fn uma_palavra_vira_prefixo_entre_aspas() {
        assert_eq!(to_fts_query("bio").as_deref(), Some("\"bio\"*"));
    }

    #[test]
    fn so_a_ultima_palavra_ganha_o_operador_de_prefixo() {
        assert_eq!(to_fts_query("revisao bio").as_deref(), Some("\"revisao\" \"bio\"*"));
    }

    #[test]
    fn acento_e_preservado_porque_quem_ignora_acento_e_o_tokenizador() {
        // `remove_diacritics 2` acontece do lado do FTS5, na indexação E na
        // consulta. Tirar acento aqui seria fazer o trabalho duas vezes — e
        // errado, já que o Rust não sabe as regras que o tokenizador usa.
        assert_eq!(to_fts_query("mitocôndria").as_deref(), Some("\"mitocôndria\"*"));
    }

    /// O caso que derrubava a busca inteira: qualquer pontuação com
    /// significado na linguagem do FTS5 chegando crua.
    #[test]
    fn pontuacao_de_sintaxe_do_fts_nunca_chega_ao_motor() {
        for entrada in ["aula 3: mitocôndria", "bio*", "\"frase\"", "a NEAR b", "-nega", "col:valor", "(x)"] {
            let consulta = to_fts_query(entrada).unwrap_or_default();
            let sem_aspas_de_termo = consulta.replace(['"', '*'], "");
            assert!(
                !sem_aspas_de_termo.contains(':')
                    && !sem_aspas_de_termo.contains('(')
                    && !sem_aspas_de_termo.contains(')')
                    && !sem_aspas_de_termo.contains('-'),
                "entrada {entrada:?} deixou passar sintaxe do FTS5: {consulta}"
            );
        }
    }

    #[test]
    fn entrada_so_de_pontuacao_nao_vira_consulta() {
        assert_eq!(to_fts_query("!!! ??? ..."), None);
    }

    #[test]
    fn consulta_gigante_e_cortada_nos_dois_eixos() {
        let muitas_palavras = vec!["bio"; 500].join(" ");
        let consulta = to_fts_query(&muitas_palavras).unwrap_or_default();
        assert_eq!(consulta.matches("bio").count(), MAX_TERMOS);

        let palavra_gigante = "a".repeat(5_000);
        let consulta = to_fts_query(&palavra_gigante).unwrap_or_default();
        // `"` + termo + `"` + `*`
        assert_eq!(consulta.len(), MAX_CARACTERES_POR_TERMO + 3);
    }
}
