//! Repository for the deck tree — Fase 4's `decks` table
//! (`0010_decks_note_types.sql`). Mirrors `db::pages`'s shape almost exactly
//! (fractional sibling order via `db::position`, soft delete, the same
//! "hide a whole trashed subtree" recursive walk) because a deck is the same
//! kind of tree as a page, with two differences: nothing here ever moves a
//! deck between parents (the contract has no `move_deck`), and there is no
//! hard/permanent delete — trashing is the only removal path this piece
//! implements.
//!
//! ## O que acontece com os cartões de um deck apagado
//!
//! `decks` só existe como FK `ON DELETE SET NULL`/`ON DELETE RESTRICT` a
//! partir de `notes.deck_id` e `cards.deck_id` — apagar a LINHA de um deck
//! com nota ou cartão dentro falharia contra `RESTRICT` de propósito (ver o
//! comentário da migração). Este repositório nunca tenta o `DELETE`: `trash`
//! só grava `deleted_at`, então a constraint nunca entra em jogo. As notas e
//! os cartões continuam existindo, com `deck_id` apontando para um deck
//! agora trashed — nada aqui os move, suspende ou apaga. `list_tree` deixa de
//! devolver esse deck (e qualquer descendente dele, pelo mesmo motivo do
//! `WHERE ... deleted_at IS NULL` em cada nível da CTE recursiva de
//! `db::pages::list_tree`), então a árvore ativa não mostra mais aquele
//! ramo — mas os cartões que estudavam ali não desaparecem da tabela
//! `cards`, e decidir se a fila de estudo (`deck_counts`/`next_card`, fora do
//! escopo desta peça) deve filtrar por deck ativo fica para quem implementa
//! aquele lado do contrato.
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value as JsonValue;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::db::position;
use crate::error::{Error, Result};

const DECK_COLUMNS: &str = "id, parent_id, name, options, position, deleted_at, created_at, updated_at";

/// Mirrors the shape the frontend's deck tree will build from — `camelCase`
/// on the wire, same convention `BlockRow`/`RecordValueRow` already use for
/// every Fase 2+ struct (see the note on `#[serde(rename_all)]` in
/// `db::blocks::BlockRow`'s doc comment for why `PageRow`, Fase 1, is the
/// one exception).
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbIdOpt")]
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub options: JsonValue,
    pub position: String,
    pub deleted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct DeckRepository {
    pool: SqlitePool,
}

impl DeckRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Creates a deck as the last active child of `parent_id` (or a new root
    /// deck when `parent_id` is `None`). A `parent_id` that does not name an
    /// existing deck surfaces as the FK's own `Error::Database` — the same
    /// choice `PageRepository::create` makes for pages, rather than this
    /// repository pre-checking existence itself.
    pub async fn create(&self, parent_id: Option<Uuid>, name: &str) -> Result<DeckRow> {
        let new_position = self.next_position_under(parent_id).await?;
        let id = Uuid::now_v7();

        let row = sqlx::query_as::<_, DeckRow>(&format!(
            "INSERT INTO decks (id, parent_id, name, position) VALUES ($1, $2, $3, $4) RETURNING {DECK_COLUMNS}"
        ))
        .bind(id.db())
        .bind(parent_id.db())
        .bind(name)
        .bind(&new_position)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    /// Reads a deck regardless of trash state.
    pub async fn get(&self, id: Uuid) -> Result<DeckRow> {
        sqlx::query_as::<_, DeckRow>(&format!("SELECT {DECK_COLUMNS} FROM decks WHERE id = $1"))
            .bind(id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("baralho {id}")))
    }

    pub async fn rename(&self, id: Uuid, name: &str) -> Result<DeckRow> {
        sqlx::query_as::<_, DeckRow>(&format!(
            "UPDATE decks SET name = $2 WHERE id = $1 RETURNING {DECK_COLUMNS}"
        ))
        .bind(id.db())
        .bind(name)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("baralho {id}")))
    }

    /// Lê a configuração de agendamento (SM-2 e FSRS) de um baralho — sempre
    /// a visão JÁ NORMALIZADA (`db::cards::parse_opcoes_de_deck` aplicado),
    /// nunca o JSON cru de `decks.options`: um baralho recém-criado
    /// (`options = '{}'`) devolve exatamente os defaults de
    /// `crate::srs::OpcoesDeDeck::default()`, e um `options` corrompido
    /// devolve o mesmo default em vez de vazar o erro de parse para quem
    /// chamou o comando IPC `get_deck_scheduling_options`.
    pub async fn get_scheduling_options(&self, id: Uuid) -> Result<crate::db::cards::OpcoesDeDeckJson> {
        let deck = self.get(id).await?;
        Ok(crate::db::cards::parse_opcoes_de_deck(&deck.options).into())
    }

    /// Grava a configuração de agendamento de um baralho, inclusive a
    /// escolha de agendador (`agendador: "sm2" | "fsrs"`). NÃO migra nenhum
    /// cartão já existente — só afeta cartão criado DAQUI PRA FRENTE (ver a
    /// decisão documentada em `db::cards::CardRepository::answer_card`, e a
    /// prova em `db::notes::NoteRepository::deck_scheduler`/`insert_card`,
    /// que leem esta mesma chave a cada nota criada).
    pub async fn set_scheduling_options(&self, id: Uuid, opcoes: crate::db::cards::OpcoesDeDeckJson) -> Result<DeckRow> {
        // `OpcoesDeDeckJson` é sempre bem-formado por construção (`serde` já
        // recusou, antes de chegar aqui, um `fsrs_pesos` que não seja um
        // array de exatamente 21 números) — a serialização de volta para
        // `serde_json::Value` não tem como falhar de verdade para este tipo,
        // mas propagamos como erro em vez de `unwrap`/`expect` mesmo assim
        // (regra 3).
        let json = serde_json::to_value(opcoes)
            .map_err(|erro| Error::Invalid(format!("opções de agendamento não serializam para JSON: {erro}")))?;

        sqlx::query_as::<_, DeckRow>(&format!("UPDATE decks SET options = $2 WHERE id = $1 RETURNING {DECK_COLUMNS}"))
            .bind(id.db())
            .bind(json)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("baralho {id}")))
    }

    /// Soft delete — the only removal path this repository offers. Rejects a
    /// deck that is already trashed instead of silently no-op'ing, mirroring
    /// `PageRepository::trash`, so a caller retrying a stale action finds out.
    pub async fn trash(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query(
            "UPDATE decks SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(id.db())
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            self.get(id).await?;
            return Err(Error::Invalid("baralho já está na lixeira".into()));
        }

        Ok(())
    }

    /// Active decks, flat with `parent_id` for the caller to rebuild the
    /// tree — same recursive-CTE shape as `PageRepository::list_tree`, which
    /// means a trashed deck (and everything under it) simply stops appearing
    /// here without any write touching its descendants.
    pub async fn list_tree(&self, root: Option<Uuid>) -> Result<Vec<DeckRow>> {
        let rows = sqlx::query_as::<_, DeckRow>(
            "WITH RECURSIVE tree AS ( \
                 SELECT id, parent_id, name, options, position, deleted_at, created_at, updated_at, 0 AS depth \
                 FROM decks WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL \
                 UNION ALL \
                 SELECT d.id, d.parent_id, d.name, d.options, d.position, d.deleted_at, d.created_at, d.updated_at, t.depth + 1 \
                 FROM decks d JOIN tree t ON d.parent_id = t.id \
                 WHERE d.deleted_at IS NULL \
             ) \
             SELECT id, parent_id, name, options, position, deleted_at, created_at, updated_at \
             FROM tree ORDER BY depth, position",
        )
        .bind(root.db())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    async fn next_position_under(&self, parent_id: Option<Uuid>) -> Result<String> {
        let last: Option<String> = sqlx::query_scalar(
            "SELECT position FROM decks WHERE parent_id IS NOT DISTINCT FROM $1 AND deleted_at IS NULL ORDER BY position DESC LIMIT 1",
        )
        .bind(parent_id.db())
        .fetch_optional(&self.pool)
        .await?;

        let last_index = last.as_deref().map(position::parse).transpose()?;
        position::between(last_index.as_ref(), None)
    }
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::{Path, PathBuf};

    use super::*;
    use crate::db::pool::connect_and_migrate;

    fn temp_database_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("learno-decks-test-{label}-{}.sqlite", Uuid::new_v4()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let mut wal = path.as_os_str().to_os_string();
        wal.push("-wal");
        let _ = std::fs::remove_file(wal);
        let mut shm = path.as_os_str().to_os_string();
        shm.push("-shm");
        let _ = std::fs::remove_file(shm);
    }

    #[tokio::test]
    async fn create_places_the_deck_as_a_new_root_and_reads_it_back() {
        let db_path = temp_database_path("create-root");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let repo = DeckRepository::new(pool.clone());

        let deck = repo.create(None, "Biologia").await.unwrap();
        assert_eq!(deck.name, "Biologia");
        assert_eq!(deck.parent_id, None);
        assert!(deck.deleted_at.is_none());

        let fetched = repo.get(deck.id).await.unwrap();
        assert_eq!(fetched, deck);

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn create_under_a_parent_nests_the_deck_and_list_tree_returns_both() {
        let db_path = temp_database_path("create-nested");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let repo = DeckRepository::new(pool.clone());

        let parent = repo.create(None, "Biologia").await.unwrap();
        let child = repo.create(Some(parent.id), "Citologia").await.unwrap();
        assert_eq!(child.parent_id, Some(parent.id));

        let tree = repo.list_tree(None).await.unwrap();
        let ids: Vec<Uuid> = tree.iter().map(|d| d.id).collect();
        assert!(ids.contains(&parent.id));
        assert!(ids.contains(&child.id));

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn rename_changes_the_name_and_reports_not_found_for_a_missing_deck() {
        let db_path = temp_database_path("rename");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let repo = DeckRepository::new(pool.clone());

        let deck = repo.create(None, "Nome Velho").await.unwrap();
        let renamed = repo.rename(deck.id, "Nome Novo").await.unwrap();
        assert_eq!(renamed.name, "Nome Novo");

        let missing = repo.rename(Uuid::now_v7(), "x").await;
        assert!(matches!(missing, Err(Error::NotFound(_))));

        pool.close().await;
        cleanup(&db_path);
    }

    /// O ponto central deste repositório: trashing NUNCA tenta um `DELETE`
    /// de verdade (a FK é `RESTRICT` de propósito), e uma segunda tentativa
    /// sobre o mesmo deck é rejeitada em vez de silenciosamente não fazer
    /// nada.
    #[tokio::test]
    async fn trash_hides_the_deck_and_its_subtree_from_list_tree_without_deleting_rows() {
        let db_path = temp_database_path("trash");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let repo = DeckRepository::new(pool.clone());

        let parent = repo.create(None, "Biologia").await.unwrap();
        let child = repo.create(Some(parent.id), "Citologia").await.unwrap();

        repo.trash(parent.id).await.unwrap();

        let tree = repo.list_tree(None).await.unwrap();
        assert!(tree.is_empty(), "trashing the root deve esconder o filho junto, mesmo o filho continuando ativo");

        // A linha continua existindo — `get` (que ignora o estado de lixeira)
        // ainda a encontra.
        let still_there = repo.get(child.id).await.unwrap();
        assert_eq!(still_there.id, child.id);

        let second_attempt = repo.trash(parent.id).await;
        assert!(matches!(second_attempt, Err(Error::Invalid(_))));

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn trash_of_an_unknown_deck_reports_not_found() {
        let db_path = temp_database_path("trash-missing");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let repo = DeckRepository::new(pool.clone());

        let result = repo.trash(Uuid::now_v7()).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        cleanup(&db_path);
    }
}
