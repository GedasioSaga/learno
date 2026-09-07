//! Comandos `#[tauri::command]` para baralho (deck), tipo de nota e nota —
//! Fase 4's SRS foundation. Segue exatamente o desenho de `ipc::commands` e
//! `ipc::block_commands`: cada comando monta o repositório certo a partir de
//! `state.pool()` e delega a ele, com um par `_inner` testável sem
//! `AppHandle` — ver o comentário de `page_repository` em `ipc::commands`
//! para por que nenhum teste aqui pode passar por `tauri::test::mock_builder`.

use tauri::State;
use uuid::Uuid;

use crate::db::cards::OpcoesDeDeckJson;
use crate::db::{DeckRepository, DeckRow, FieldValues, NoteRepository, NoteRow, NoteTypeRepository, NoteTypeRow};
use crate::error::Result;
use crate::ipc::state::AppState;

fn deck_repository(state: &AppState) -> Result<DeckRepository> {
    Ok(DeckRepository::new(state.pool()?))
}

fn note_type_repository(state: &AppState) -> Result<NoteTypeRepository> {
    Ok(NoteTypeRepository::new(state.pool()?))
}

fn note_repository(state: &AppState) -> Result<NoteRepository> {
    Ok(NoteRepository::new(state.pool()?))
}

/// A árvore de baralhos ativos inteira, flat com `parent_id` — a mesma forma
/// que `list_page_tree` já devolve para páginas.
#[tauri::command]
pub async fn list_decks(state: State<'_, AppState>) -> Result<Vec<DeckRow>> {
    list_decks_inner(&state).await
}

async fn list_decks_inner(state: &AppState) -> Result<Vec<DeckRow>> {
    deck_repository(state)?.list_tree(None).await
}

/// Cria um baralho como o último filho ativo de `parent_id` (raiz quando
/// `None`).
#[tauri::command]
pub async fn create_deck(state: State<'_, AppState>, name: String, parent_id: Option<Uuid>) -> Result<DeckRow> {
    create_deck_inner(&state, &name, parent_id).await
}

async fn create_deck_inner(state: &AppState, name: &str, parent_id: Option<Uuid>) -> Result<DeckRow> {
    deck_repository(state)?.create(parent_id, name).await
}

#[tauri::command]
pub async fn rename_deck(state: State<'_, AppState>, deck_id: Uuid, name: String) -> Result<DeckRow> {
    rename_deck_inner(&state, deck_id, &name).await
}

async fn rename_deck_inner(state: &AppState, deck_id: Uuid, name: &str) -> Result<DeckRow> {
    deck_repository(state)?.rename(deck_id, name).await
}

/// Soft delete — ver o comentário de `DeckRepository::trash` para o que
/// acontece (e o que NÃO acontece) com as notas e os cartões do baralho.
#[tauri::command]
pub async fn delete_deck(state: State<'_, AppState>, deck_id: Uuid) -> Result<()> {
    delete_deck_inner(&state, deck_id).await
}

async fn delete_deck_inner(state: &AppState, deck_id: Uuid) -> Result<()> {
    deck_repository(state)?.trash(deck_id).await
}

/// Lê a configuração de agendamento (SM-2 e FSRS) de um baralho — sempre a
/// visão já normalizada, nunca o JSON cru de `decks.options`. Sem isto a UI
/// não tem como sequer MOSTRAR se um baralho está em SM-2 ou FSRS, quanto
/// menos oferecer a troca — ver `DeckRepository::get_scheduling_options`.
#[tauri::command]
pub async fn get_deck_scheduling_options(state: State<'_, AppState>, deck_id: Uuid) -> Result<OpcoesDeDeckJson> {
    get_deck_scheduling_options_inner(&state, deck_id).await
}

async fn get_deck_scheduling_options_inner(state: &AppState, deck_id: Uuid) -> Result<OpcoesDeDeckJson> {
    deck_repository(state)?.get_scheduling_options(deck_id).await
}

/// Grava a configuração de agendamento de um baralho — inclusive a troca de
/// agendador (`agendador: "sm2" | "fsrs"`). NÃO migra cartão nenhum: só afeta
/// cartão criado DAQUI PRA FRENTE — ver a decisão de migração documentada em
/// `db::cards::CardRepository::answer_card` (braço "fsrs") e
/// `DeckRepository::set_scheduling_options`. Sem este comando, a escolha de
/// agendador ficaria travada no default para sempre — o mesmo defeito que
/// este projeto já viu se repetir nove vezes: peça correta, sem ligação até
/// o app de verdade.
#[tauri::command]
pub async fn set_deck_scheduling_options(
    state: State<'_, AppState>,
    deck_id: Uuid,
    opcoes: OpcoesDeDeckJson,
) -> Result<DeckRow> {
    set_deck_scheduling_options_inner(&state, deck_id, opcoes).await
}

async fn set_deck_scheduling_options_inner(
    state: &AppState,
    deck_id: Uuid,
    opcoes: OpcoesDeDeckJson,
) -> Result<DeckRow> {
    deck_repository(state)?.set_scheduling_options(deck_id, opcoes).await
}

/// Todo tipo de nota, semeando o "Básico" (Frente/Verso) na primeira chamada
/// contra um banco que ainda não tem nenhum — ver
/// `NoteTypeRepository::list`.
#[tauri::command]
pub async fn list_note_types(state: State<'_, AppState>) -> Result<Vec<NoteTypeRow>> {
    list_note_types_inner(&state).await
}

async fn list_note_types_inner(state: &AppState) -> Result<Vec<NoteTypeRow>> {
    note_type_repository(state)?.list().await
}

/// Cria uma nota e, na mesma transação, um cartão por template do tipo de
/// nota — ver o comentário de módulo de `db::notes` e de
/// `NoteRepository::create_with_source`.
///
/// `source_block_id`/`source_text_frozen` são AMBOS opcionais e independentes
/// (INT-003/INT-009) — `null` nos dois é o caminho normal de sempre, uma nota
/// criada direto no navegador, e não passou a exigir nada novo. Ver o
/// comentário de `NoteRepository::create_with_source` para a tabela completa
/// de combinações (só bloco, só texto — o caso de um nó de mapa mental, que
/// não tem bloco para linkar — ou os dois).
#[tauri::command]
pub async fn create_note(
    state: State<'_, AppState>,
    deck_id: Uuid,
    note_type_id: Uuid,
    field_values: FieldValues,
    tags: Vec<String>,
    source_block_id: Option<Uuid>,
    source_text_frozen: Option<String>,
) -> Result<NoteRow> {
    create_note_inner(&state, deck_id, note_type_id, field_values, tags, source_block_id, source_text_frozen).await
}

async fn create_note_inner(
    state: &AppState,
    deck_id: Uuid,
    note_type_id: Uuid,
    field_values: FieldValues,
    tags: Vec<String>,
    source_block_id: Option<Uuid>,
    source_text_frozen: Option<String>,
) -> Result<NoteRow> {
    note_repository(state)?
        .create_with_source(deck_id, note_type_id, field_values, tags, source_block_id, source_text_frozen)
        .await
}

/// Atualiza os valores de campo e as tags de uma nota. Nunca recria nem
/// apaga os cartões existentes — ver `NoteRepository::update`.
#[tauri::command]
pub async fn update_note(
    state: State<'_, AppState>,
    note_id: Uuid,
    field_values: FieldValues,
    tags: Vec<String>,
) -> Result<NoteRow> {
    update_note_inner(&state, note_id, field_values, tags).await
}

async fn update_note_inner(
    state: &AppState,
    note_id: Uuid,
    field_values: FieldValues,
    tags: Vec<String>,
) -> Result<NoteRow> {
    note_repository(state)?.update(note_id, field_values, tags).await
}

/// Soft delete de nota — suspende (não apaga) os cartões dela, ver
/// `NoteRepository::delete`.
#[tauri::command]
pub async fn delete_note(state: State<'_, AppState>, note_id: Uuid) -> Result<()> {
    delete_note_inner(&state, note_id).await
}

async fn delete_note_inner(state: &AppState, note_id: Uuid) -> Result<()> {
    note_repository(state)?.delete(note_id).await
}

/// Notas ativas, opcionalmente restritas a um baralho, mais recentes
/// primeiro.
#[tauri::command]
pub async fn list_notes(
    state: State<'_, AppState>,
    deck_id: Option<Uuid>,
    limit: i64,
    offset: i64,
) -> Result<Vec<NoteRow>> {
    list_notes_inner(&state, deck_id, limit, offset).await
}

async fn list_notes_inner(state: &AppState, deck_id: Option<Uuid>, limit: i64, offset: i64) -> Result<Vec<NoteRow>> {
    note_repository(state)?.list(deck_id, limit, offset).await
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    fn campos(pares: &[(&str, &str)]) -> FieldValues {
        pares.iter().map(|(nome, valor)| ((*nome).to_string(), (*valor).to_string())).collect()
    }

    fn frente_verso(frente: &str, verso: &str) -> FieldValues {
        campos(&[("Frente", frente), ("Verso", verso)])
    }

    use super::*;
    use crate::error::Error;

    // Um representante por comando prova que cada um está de fato ligado a
    // `page_repository`-style "sem pool ainda" — mesmo padrão de
    // `ipc::commands::tests::page_commands_without_a_pool`.
    mod without_a_pool {
        use super::*;

        #[tokio::test]
        async fn list_decks_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(list_decks_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn create_deck_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(create_deck_inner(&state, "x", None).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn delete_deck_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(delete_deck_inner(&state, Uuid::now_v7()).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn list_note_types_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(list_note_types_inner(&state).await, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn create_note_reports_not_connected() {
            let state = AppState::new();
            let result =
                create_note_inner(&state, Uuid::now_v7(), Uuid::now_v7(), FieldValues::new(), vec![], None, None).await;
            assert!(matches!(result, Err(Error::Config(_))));
        }

        #[tokio::test]
        async fn list_notes_reports_not_connected() {
            let state = AppState::new();
            assert!(matches!(list_notes_inner(&state, None, 10, 0).await, Err(Error::Config(_))));
        }
    }

    // Testes de ponta a ponta contra banco de verdade (arquivo temporário) —
    // mesmo padrão do módulo `com_banco` em `ipc::commands`. A lógica de
    // negócio já está coberta em `db::decks`/`db::notes`; o que falta provar
    // aqui é só a fiação: que o comando de fato chega ao repositório certo.
    mod com_banco {
        #![allow(clippy::unwrap_used, clippy::expect_used)]

        use std::path::PathBuf;

        use super::*;
        use crate::db::pool::connect_and_migrate;

        fn pasta_temporaria(rotulo: &str) -> PathBuf {
            std::env::temp_dir().join(format!("learno-deck-cmd-test-{rotulo}-{}", Uuid::new_v4()))
        }

        async fn estado_com_banco(rotulo: &str) -> (AppState, PathBuf) {
            let data_dir = pasta_temporaria(rotulo);
            let db_path = data_dir.join("learno.sqlite");
            let pool = connect_and_migrate(&db_path).await.unwrap();
            let state = AppState::new();
            state.set_pool(pool);
            (state, data_dir)
        }

        #[tokio::test]
        async fn create_deck_and_list_decks_round_trip_through_the_command_layer() {
            let (state, data_dir) = estado_com_banco("cria-lista").await;

            let deck = create_deck_inner(&state, "Biologia", None).await.unwrap();
            let tree = list_decks_inner(&state).await.unwrap();
            assert!(tree.iter().any(|d| d.id == deck.id));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// Item 4 desta peça: sem estes dois comandos, a UI não tem como ler
        /// nem gravar a escolha de agendador — o defeito histórico deste
        /// projeto (peça correta, sem ligação até o app de verdade) se
        /// repetindo pela décima primeira vez. Prova o round-trip completo:
        /// baralho recém-criado lê o default (`sm2`), grava `fsrs` com uma
        /// retenção customizada, e a leitura seguinte devolve exatamente o
        /// que foi gravado.
        #[tokio::test]
        async fn get_e_set_deck_scheduling_options_fazem_o_round_trip_da_escolha_de_agendador() {
            let (state, data_dir) = estado_com_banco("scheduling-options").await;
            let deck = create_deck_inner(&state, "Biologia", None).await.unwrap();

            let padrao = get_deck_scheduling_options_inner(&state, deck.id).await.unwrap();
            assert_eq!(padrao.agendador, "sm2", "baralho recém-criado precisa ler o default sm2");
            assert!((padrao.fsrs_retencao_desejada - 0.9).abs() < 1e-9);

            let mut novas = padrao.clone();
            novas.agendador = "fsrs".to_string();
            novas.fsrs_retencao_desejada = 0.85;
            set_deck_scheduling_options_inner(&state, deck.id, novas).await.unwrap();

            let lidas = get_deck_scheduling_options_inner(&state, deck.id).await.unwrap();
            assert_eq!(lidas.agendador, "fsrs", "a gravação precisa persistir a troca de agendador");
            assert!((lidas.fsrs_retencao_desejada - 0.85).abs() < 1e-9);
            // Pesos não tocados na gravação continuam os mesmos 21 valores
            // padrão — o round-trip não perde nem embaralha o array.
            assert_eq!(lidas.fsrs_pesos, padrao.fsrs_pesos);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn create_note_through_the_command_layer_generates_a_card() {
            let (state, data_dir) = estado_com_banco("cria-nota").await;

            let deck = create_deck_inner(&state, "Biologia", None).await.unwrap();
            let note_type = list_note_types_inner(&state).await.unwrap().into_iter().next().unwrap();

            let note = create_note_inner(
                &state,
                deck.id,
                note_type.id,
                frente_verso("Mitocôndria", "Organela"),
                vec![],
                None,
                None,
            )
            .await
            .unwrap();

            let notes = list_notes_inner(&state, Some(deck.id), 10, 0).await.unwrap();
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].id, note.id);

            let pool = state.pool().unwrap();
            let card_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE note_id = ?")
                    .bind(crate::db::ids::IdBind::db(&note.id))
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(card_count, 1);

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        /// A fiação de `source_block_id`/`source_text_frozen` (INT-003/INT-009):
        /// prova que os dois campos opcionais do comando chegam de fato a
        /// `NoteRepository::create_with_source`, não só que existem na
        /// assinatura — a lógica de preenchimento em si já está coberta em
        /// `db::notes`.
        #[tokio::test]
        async fn create_note_through_the_command_layer_wires_the_source_block_id() {
            let (state, data_dir) = estado_com_banco("cria-nota-com-origem").await;

            let deck = create_deck_inner(&state, "Biologia", None).await.unwrap();
            let note_type = list_note_types_inner(&state).await.unwrap().into_iter().next().unwrap();

            let pool = state.pool().unwrap();
            let page = crate::db::PageRepository::new(pool.clone()).create(None, "Anotações").await.unwrap();
            let block = crate::db::BlockRepository::new(pool.clone())
                .create(crate::db::NewBlockInput {
                    id: None,
                    block_type: "paragraph".into(),
                    content: serde_json::json!({ "text": "Mitocôndria é a organela..." }),
                    plain_text: "Mitocôndria é a organela...".into(),
                    placement: crate::db::BlockPlacementInput { page_id: page.id, parent_block_id: None, after_block_id: None },
                })
                .await
                .unwrap();

            let note = create_note_inner(
                &state,
                deck.id,
                note_type.id,
                frente_verso("Mitocôndria", "Organela"),
                vec![],
                Some(block.id),
                None,
            )
            .await
            .unwrap();

            assert_eq!(note.source_block_id, Some(block.id));
            assert_eq!(note.source_text_frozen.as_deref(), Some("Mitocôndria é a organela..."));

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }

        #[tokio::test]
        async fn delete_deck_through_the_command_layer_hides_it_from_list_decks() {
            let (state, data_dir) = estado_com_banco("apaga-deck").await;

            let deck = create_deck_inner(&state, "Biologia", None).await.unwrap();
            delete_deck_inner(&state, deck.id).await.unwrap();

            let tree = list_decks_inner(&state).await.unwrap();
            assert!(tree.is_empty());

            state.take_pool().unwrap().close().await;
            let _ = std::fs::remove_dir_all(&data_dir);
        }
    }
}
