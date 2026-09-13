#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for the origem que `db::notes` grava numa nota —
//! `source_block_id` (INT-003, um ponteiro vivo para o bloco que originou o
//! cartão) e `source_text_frozen` (INT-009, o texto que sobrevive mesmo
//! depois que esse ponteiro zera). Mesmo padrão de `tests/db_blocks.rs`: cada
//! teste cria seu próprio banco descartável via `support::IsolatedDatabase`,
//! já migrado, sem preparação nenhuma.
//!
//! O teste central deste arquivo é
//! `apagar_o_bloco_de_origem_zera_o_ponteiro_mas_preserva_o_texto_congelado_e_o_cartao_continua_estudavel`
//! — é o único que prova por que a migração `0011_notes_cards.sql` tem DUAS
//! colunas de origem, e não uma só.

mod support;

use learno_lib::db::ids::IdBind;
use learno_lib::db::{
    BlockPlacementInput, BlockRepository, DeckRepository, FieldValues, NewBlockInput, NoteRepository, NoteTypeRepository,
    PageRepository,
};
use learno_lib::error::Error;
use sqlx::SqlitePool;
use support::IsolatedDatabase;
use uuid::Uuid;

/// O contrato de `NoteRepository::create*` é por NOME de campo (ver o
/// comentário de `FieldValues` em `db::notes`), não por posição — este açúcar
/// só evita espalhar `HashMap::from` pelo arquivo inteiro.
fn frente_verso(frente: &str, verso: &str) -> FieldValues {
    [("Frente".to_string(), frente.to_string()), ("Verso".to_string(), verso.to_string())].into_iter().collect()
}

/// Baralho + tipo de nota "Básico" (semeado por `NoteTypeRepository::list`).
async fn baralho_e_tipo(pool: &SqlitePool) -> (Uuid, Uuid) {
    let deck = DeckRepository::new(pool.clone()).create(None, "Biologia").await.unwrap();
    let note_type = NoteTypeRepository::new(pool.clone()).list().await.unwrap().into_iter().next().unwrap();
    (deck.id, note_type.id)
}

/// O mesmo par acima, mais um bloco de página real com `texto` como
/// `plain_text` — o que uma nota de origem "leia um PDF, escreva uma nota"
/// de verdade aponta para.
async fn baralho_tipo_e_bloco(pool: &SqlitePool, texto: &str) -> (Uuid, Uuid, Uuid) {
    let (deck_id, note_type_id) = baralho_e_tipo(pool).await;
    let page = PageRepository::new(pool.clone()).create(None, "Anotações de Biologia").await.unwrap();
    let block = BlockRepository::new(pool.clone())
        .create(NewBlockInput {
            id: None,
            block_type: "paragraph".into(),
            content: serde_json::json!({ "text": texto }),
            plain_text: texto.into(),
            placement: BlockPlacementInput { page_id: page.id, parent_block_id: None, after_block_id: None },
        })
        .await
        .unwrap();
    (deck_id, note_type_id, block.id)
}

/// Compatibilidade: o caminho sem origem continua sendo `create`, sem exigir
/// nenhum campo novo — este piece não pode quebrar o único jeito que
/// `db::cards`/`db::review_log` já criam nota hoje.
#[tokio::test]
async fn criar_nota_sem_origem_continua_funcionando_sem_exigir_campo_novo() {
    let db = IsolatedDatabase::setup("notes-sem-origem").await;
    let (deck_id, note_type_id) = baralho_e_tipo(&db.pool).await;
    let repo = NoteRepository::new(db.pool.clone());

    let note = repo.create(deck_id, note_type_id, frente_verso("a", "b"), vec![]).await.unwrap();

    assert_eq!(note.source_block_id, None);
    assert_eq!(note.source_text_frozen, None);

    db.teardown().await;
}

/// O caso normal: origem só com bloco. O texto congelado é preenchido
/// sozinho a partir do `plain_text` do bloco — a escolha documentada em
/// `NoteRepository::resolve_source_text`.
#[tokio::test]
async fn criar_nota_com_bloco_de_origem_sem_texto_congela_o_plain_text_do_bloco() {
    let db = IsolatedDatabase::setup("notes-origem-autofill").await;
    let (deck_id, note_type_id, block_id) = baralho_tipo_e_bloco(&db.pool, "Mitocôndria é a organela da célula.").await;
    let repo = NoteRepository::new(db.pool.clone());

    let note = repo
        .create_with_source(deck_id, note_type_id, frente_verso("Mitocôndria", "Organela"), vec![], Some(block_id), None)
        .await
        .unwrap();

    assert_eq!(note.source_block_id, Some(block_id));
    assert_eq!(note.source_text_frozen.as_deref(), Some("Mitocôndria é a organela da célula."));

    db.teardown().await;
}

/// Texto congelado em branco COM bloco não é erro: é tratado como se não
/// tivesse sido dado, e preenchido do bloco do mesmo jeito.
#[tokio::test]
async fn texto_congelado_em_branco_com_bloco_e_preenchido_do_bloco_em_vez_de_gravado_em_branco() {
    let db = IsolatedDatabase::setup("notes-origem-blank-com-bloco").await;
    let (deck_id, note_type_id, block_id) = baralho_tipo_e_bloco(&db.pool, "texto do bloco").await;
    let repo = NoteRepository::new(db.pool.clone());

    let note = repo
        .create_with_source(deck_id, note_type_id, frente_verso("a", "b"), vec![], Some(block_id), Some("   ".into()))
        .await
        .unwrap();

    assert_eq!(note.source_text_frozen.as_deref(), Some("texto do bloco"));

    db.teardown().await;
}

/// Com bloco, um texto congelado explícito e não-branco VENCE o `plain_text`
/// do bloco — a única forma de congelar só um trecho selecionado, não o
/// bloco inteiro.
#[tokio::test]
async fn texto_congelado_explicito_sobrescreve_o_plain_text_do_bloco() {
    let db = IsolatedDatabase::setup("notes-origem-override").await;
    let (deck_id, note_type_id, block_id) =
        baralho_tipo_e_bloco(&db.pool, "texto completo do bloco, bem mais longo que o trecho selecionado").await;
    let repo = NoteRepository::new(db.pool.clone());

    let note = repo
        .create_with_source(
            deck_id,
            note_type_id,
            frente_verso("a", "b"),
            vec![],
            Some(block_id),
            Some("só o trecho selecionado".into()),
        )
        .await
        .unwrap();

    assert_eq!(note.source_text_frozen.as_deref(), Some("só o trecho selecionado"));

    db.teardown().await;
}

/// O caso que a peça pede para RELATAR, não resolver: origem de um nó de
/// mapa mental. Um nó de mapa mental não é um bloco (mora em
/// `mindmap_nodes`, e `source_block_id` só referencia `blocks(id)`), então a
/// única origem que o schema de hoje permite é texto congelado sozinho, sem
/// `source_block_id` e sem link clicável de volta.
#[tokio::test]
async fn origem_so_com_texto_congelado_sem_bloco_e_aceita_caso_do_no_de_mapa_mental() {
    let db = IsolatedDatabase::setup("notes-origem-so-texto").await;
    let (deck_id, note_type_id) = baralho_e_tipo(&db.pool).await;
    let repo = NoteRepository::new(db.pool.clone());

    let note = repo
        .create_with_source(deck_id, note_type_id, frente_verso("a", "b"), vec![], None, Some("texto do nó do mapa mental".into()))
        .await
        .unwrap();

    assert_eq!(note.source_block_id, None, "não há coluna para linkar um nó de mapa mental hoje");
    assert_eq!(note.source_text_frozen.as_deref(), Some("texto do nó do mapa mental"));

    db.teardown().await;
}

/// Sem bloco E com texto só de espaços: não há nada para cair de volta, e
/// aceitar em silêncio deixaria a nota com um `source_text_frozen` inútil.
#[tokio::test]
async fn texto_congelado_em_branco_sem_bloco_e_rejeitado() {
    let db = IsolatedDatabase::setup("notes-origem-blank-sem-bloco").await;
    let (deck_id, note_type_id) = baralho_e_tipo(&db.pool).await;
    let repo = NoteRepository::new(db.pool.clone());

    let result = repo.create_with_source(deck_id, note_type_id, frente_verso("a", "b"), vec![], None, Some("   ".into())).await;

    assert!(matches!(result, Err(Error::Invalid(_))));

    let note_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes").fetch_one(&db.pool).await.unwrap();
    assert_eq!(note_count, 0, "uma criação rejeitada não pode deixar nota nenhuma para trás");

    db.teardown().await;
}

/// Um `source_block_id` que não existe (ou já não está mais ativo) falha
/// ALTO, antes de qualquer escrita — igual ao `note_type_id`/`deck_id`
/// desconhecidos que `db::notes` já recusava.
#[tokio::test]
async fn bloco_de_origem_desconhecido_e_notfound_e_nao_grava_nada() {
    let db = IsolatedDatabase::setup("notes-origem-bloco-inexistente").await;
    let (deck_id, note_type_id) = baralho_e_tipo(&db.pool).await;
    let repo = NoteRepository::new(db.pool.clone());

    let result =
        repo.create_with_source(deck_id, note_type_id, frente_verso("a", "b"), vec![], Some(Uuid::now_v7()), None).await;
    assert!(matches!(result, Err(Error::NotFound(_))));

    let note_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes").fetch_one(&db.pool).await.unwrap();
    assert_eq!(note_count, 0);

    db.teardown().await;
}

/// O TESTE CENTRAL deste arquivo — INT-009.
///
/// `BlockRepository::delete_blocks` é soft-delete (`deleted_at`), que NÃO
/// dispara `ON DELETE SET NULL` porque a linha continua existindo de
/// verdade. O que dispara é a remoção FÍSICA da linha — o caminho real disso
/// no app é a purga definitiva de uma página apagada, cujo `blocks.page_id
/// ... ON DELETE CASCADE` (`0006_blocks.sql`) leva os blocos junto. Este
/// teste simula essa remoção física direto, para provar o efeito da FK sem
/// depender do fluxo de purga de página inteiro (fora do escopo desta peça).
#[tokio::test]
async fn apagar_o_bloco_de_origem_zera_o_ponteiro_mas_preserva_o_texto_congelado_e_o_cartao_continua_estudavel() {
    let db = IsolatedDatabase::setup("notes-int-009").await;
    let (deck_id, note_type_id, block_id) =
        baralho_tipo_e_bloco(&db.pool, "A mitocôndria é a organela responsável pela respiração celular.").await;
    let repo = NoteRepository::new(db.pool.clone());

    let note = repo
        .create_with_source(deck_id, note_type_id, frente_verso("Mitocôndria", "Organela"), vec![], Some(block_id), None)
        .await
        .unwrap();
    assert_eq!(note.source_block_id, Some(block_id));
    assert_eq!(
        note.source_text_frozen.as_deref(),
        Some("A mitocôndria é a organela responsável pela respiração celular.")
    );

    // A remoção física em si — o que a FK `ON DELETE SET NULL` de fato escuta.
    sqlx::query("DELETE FROM blocks WHERE id = ?").bind(block_id.db()).execute(&db.pool).await.unwrap();

    let (source_block_id, source_text_frozen): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT source_block_id, source_text_frozen FROM notes WHERE id = ?")
            .bind(note.id.db())
            .fetch_one(&db.pool)
            .await
            .unwrap();

    assert_eq!(source_block_id, None, "a FK ON DELETE SET NULL precisa ter zerado o ponteiro");
    assert_eq!(
        source_text_frozen.as_deref(),
        Some("A mitocôndria é a organela responsável pela respiração celular."),
        "o texto congelado precisa sobreviver à exclusão do bloco — é a razão da coluna existir"
    );

    // E o cartão gerado junto com a nota continua de pé e estudável: a FK é
    // de `notes.source_block_id`, não de `cards` — nada aqui toca `cards`.
    let card_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE note_id = ?").bind(note.id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(card_count, 1, "apagar o bloco de origem não pode levar o cartão junto");

    let card_state: String =
        sqlx::query_scalar("SELECT state FROM cards WHERE note_id = ?").bind(note.id.db()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(card_state, "new", "o cartão continua no fluxo normal de estudo, não suspenso nem perdido");

    db.teardown().await;
}
