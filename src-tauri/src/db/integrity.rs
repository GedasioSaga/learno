//! "Check Database" (PLT-014): finds and repairs rows that violate the
//! schema's own invariants but slipped past its constraints anyway.
//!
//! The schema's foreign keys (`cards.note_id REFERENCES notes(id) ON DELETE
//! CASCADE`, in particular) already make an orphaned card impossible through
//! any of this app's own code paths — deleting a note takes its cards with
//! it. This exists for the cases that don't go through those code paths at
//! all: a `.apkg`/`.colpkg` import (PLT-004) that inserts rows out of order,
//! a `pg_restore` (PLT-011) of a dump taken mid-write, or direct `psql`
//! surgery. Anki's own "Check Database" exists for exactly the same reason,
//! on a database (SQLite, historically without foreign keys enforced) where
//! this kind of drift was the common case rather than the rare one.

use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::ids::DbId;
use crate::error::Result;

/// What one run of [`IntegrityRepository::check_and_repair`] found and fixed.
/// `total_repaired` is redundant with the vector lengths but is what the
/// UI's "N problemas corrigidos" summary line reads directly, so it doesn't
/// have to know which fields exist to compute it.
#[derive(Debug, Clone, Default, Serialize)]
pub struct IntegrityReport {
    pub orphaned_card_ids: Vec<Uuid>,
    pub total_repaired: usize,
}

pub struct IntegrityRepository {
    pool: SqlitePool,
}

impl IntegrityRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// PLT-014: deletes every card whose `note_id` no longer matches an
    /// existing note and reports which ones. A single statement rather than
    /// select-then-delete: nothing has to be true of the row set between the
    /// two steps for this to stay correct, because there is only one step.
    pub async fn check_and_repair(&self) -> Result<IntegrityReport> {
        // Lido como `DbId` (TEXT) e convertido de volta para `Uuid` aqui dentro —
        // ver `crate::db::ids` para o porquê: `sqlx-sqlite` decodifica `Uuid`
        // como BLOB de 16 bytes, e a coluna é TEXT numa tabela `STRICT`.
        let orphaned_card_ids: Vec<DbId> =
            sqlx::query_scalar("DELETE FROM cards WHERE note_id NOT IN (SELECT id FROM notes) RETURNING id")
                .fetch_all(&self.pool)
                .await?;
        let orphaned_card_ids: Vec<Uuid> = orphaned_card_ids.into_iter().map(Uuid::from).collect();

        let total_repaired = orphaned_card_ids.len();
        Ok(IntegrityReport { orphaned_card_ids, total_repaired })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::PathBuf;

    use super::*;
    use crate::db::ids::IdBind;

    /// Um banco descartavel, migrado e pronto para usar, que nenhum outro
    /// teste enxerga.
    ///
    /// `check_and_repair` varre a tabela `cards` INTEIRA por desenho — um
    /// verificador de consistencia nao tem `WHERE` para se limitar — entao
    /// nao ha como deixar os testes deterministicos num banco compartilhado
    /// com qualquer outra coisa que toque `cards`/`notes` enquanto o
    /// `cargo test` roda tudo em paralelo. Antes isso exigia `CREATE
    /// DATABASE` num cluster Postgres de pe (e, por isso, `#[ignore]`);
    /// agora e um arquivo em pasta temporaria, e os dois testes rodam
    /// sempre.
    struct IsolatedDatabase {
        pool: SqlitePool,
        path: PathBuf,
    }

    impl IsolatedDatabase {
        async fn setup() -> Self {
            let path = std::env::temp_dir().join(format!("learno-integrity-test-{}.sqlite", Uuid::new_v4()));
            let pool = crate::db::pool::connect_and_migrate(&path)
                .await
                .expect("falhou ao conectar/migrar o banco de teste isolado");
            Self { pool, path }
        }

        /// Fecha o pool e apaga o arquivo (e os sidecars de WAL). Nao e um
        /// `Drop`: fechar o pool e `async`, e `Drop` nao roda `async`.
        async fn teardown(self) {
            self.pool.close().await;
            let _ = std::fs::remove_file(&self.path);
            for sufixo in ["-wal", "-shm"] {
                let mut com_sufixo = self.path.clone().into_os_string();
                com_sufixo.push(sufixo);
                let _ = std::fs::remove_file(PathBuf::from(com_sufixo));
            }
        }
    }

    /// Insere um cartao cujo `note_id` nao aponta para nota nenhuma,
    /// desligando a checagem de chave estrangeira nesta conexao so.
    ///
    /// E o equivalente SQLite do `session_replication_role = replica` que a
    /// versao Postgres usava, e continua sendo a unica forma de reproduzir a
    /// "inconsistencia introduzida artificialmente" do PLT-014, dado que a
    /// constraint impede isso por todo caminho de escrita normal. `PRAGMA
    /// foreign_keys` e por conexao: religar antes de devolver a conexao ao
    /// pool nao deixa rastro.
    ///
    /// `.db()` em todo id nao e enfeite: `sqlx` codifica `Uuid` como BLOB por
    /// padrao, e a coluna e `TEXT` numa tabela `STRICT` — sem a ponte de
    /// `db::ids` o INSERT falha com "cannot store BLOB value in TEXT column".
    async fn insert_orphaned_card(pool: &SqlitePool) -> Uuid {
        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut *conn).await.unwrap();

        let card_id = Uuid::now_v7();
        sqlx::query("INSERT INTO cards (id, note_id, deck_id) VALUES (?, ?, ?)")
            .bind(card_id.db())
            .bind(Uuid::now_v7().db())
            .bind(Uuid::now_v7().db())
            .execute(&mut *conn)
            .await
            .unwrap();

        sqlx::query("PRAGMA foreign_keys = ON").execute(&mut *conn).await.unwrap();
        card_id
    }

    #[tokio::test]
    async fn plt_014_an_orphaned_card_is_detected_and_deleted() {
        let db = IsolatedDatabase::setup().await;

        let orphan_id = insert_orphaned_card(&db.pool).await;

        let repo = IntegrityRepository::new(db.pool.clone());
        let report = repo.check_and_repair().await.unwrap();

        assert_eq!(report.total_repaired, 1);
        assert_eq!(report.orphaned_card_ids, vec![orphan_id]);

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE id = ?")
            .bind(orphan_id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0);

        db.teardown().await;
    }

    #[tokio::test]
    async fn plt_014_a_database_with_no_orphans_reports_nothing_repaired() {
        let db = IsolatedDatabase::setup().await;

        let repo = IntegrityRepository::new(db.pool.clone());
        let report = repo.check_and_repair().await.unwrap();

        assert_eq!(report.total_repaired, 0);
        assert!(report.orphaned_card_ids.is_empty());

        db.teardown().await;
    }
}
