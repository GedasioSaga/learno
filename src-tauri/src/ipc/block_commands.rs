//! Comandos `#[tauri::command]` para o bloco — a persistência por trás de
//! `BlockCommands` em `src/features/editor/contract.ts`, mais os comandos que
//! o contrato não cobria (backlinks, blocos sincronizados) porque ele é
//! deliberadamente só sobre CRUD genérico de bloco.
//!
//! Segue exatamente o desenho de `ipc::commands`: cada comando monta o
//! repositório certo a partir de `state.pool()` e delega a ele.

use tauri::State;
use uuid::Uuid;

use crate::db::{
    BacklinkRepository, BacklinkRow, BlockChangeInput, BlockPatchInput, BlockPlacementInput, BlockRepository, BlockRow,
    NewBlockInput, OutgoingLinkRow,
};
use crate::error::Result;
use crate::ipc::state::AppState;

fn block_repository(state: &AppState) -> Result<BlockRepository> {
    Ok(BlockRepository::new(state.pool()?))
}

fn backlink_repository(state: &AppState) -> Result<BacklinkRepository> {
    Ok(BacklinkRepository::new(state.pool()?))
}

/// `BlockCommands.list_page_blocks`: a árvore inteira de blocos ativos da
/// página, em ordem de documento.
#[tauri::command]
pub async fn list_page_blocks(state: State<'_, AppState>, page_id: Uuid) -> Result<Vec<BlockRow>> {
    block_repository(&state)?.list_page_blocks(page_id).await
}

/// `BlockCommands.create_block`.
#[tauri::command]
pub async fn create_block(state: State<'_, AppState>, block: NewBlockInput) -> Result<BlockRow> {
    block_repository(&state)?.create(block).await
}

/// `BlockCommands.update_block`. Quando `id` participa de um grupo de blocos
/// sincronizados (EDT-073/074), propaga o patch para o original e todas as
/// cópias — ver o comentário de `BlockRepository::update`.
#[tauri::command]
pub async fn update_block(state: State<'_, AppState>, id: Uuid, patch: BlockPatchInput) -> Result<BlockRow> {
    block_repository(&state)?.update(id, patch).await
}

/// `BlockCommands.delete_blocks`: exclusão lógica em lote, com a subárvore
/// viva de cada bloco também excluída. Recusa o lote inteiro se algum dos
/// blocos for um original sincronizado com cópias vivas — ver
/// `delete_synced_original` para o fluxo com aviso do EDT-078.
#[tauri::command]
pub async fn delete_blocks(state: State<'_, AppState>, ids: Vec<Uuid>) -> Result<()> {
    block_repository(&state)?.delete_blocks(&ids).await
}

/// `BlockCommands.move_block`.
#[tauri::command]
pub async fn move_block(state: State<'_, AppState>, id: Uuid, placement: BlockPlacementInput) -> Result<BlockRow> {
    block_repository(&state)?.move_block(id, placement).await
}

/// `BlockCommands.apply_block_changes`: o autosave do editor entra aqui —
/// muitas mudanças pequenas por lote, aplicadas atomicamente numa única
/// transação.
#[tauri::command]
pub async fn apply_block_changes(state: State<'_, AppState>, changes: Vec<BlockChangeInput>) -> Result<Vec<BlockRow>> {
    block_repository(&state)?.apply_changes(changes).await
}

/// FUN-044: backlinks de `page_id` — todo bloco, em qualquer página ativa,
/// que a menciona ou linka. Não faz parte de `BlockCommands`; é aditivo ao
/// contrato para o rodapé "Backlinks" da página.
#[tauri::command]
pub async fn list_backlinks(state: State<'_, AppState>, page_id: Uuid) -> Result<Vec<BacklinkRow>> {
    backlink_repository(&state)?.list_backlinks(page_id).await
}

/// A direção inversa de [`list_backlinks`]: para o que `page_id` linka.
#[tauri::command]
pub async fn list_outgoing_links(state: State<'_, AppState>, page_id: Uuid) -> Result<Vec<OutgoingLinkRow>> {
    backlink_repository(&state)?.list_outgoing_links(page_id).await
}

/// EDT-073: cola uma cópia sincronizada de `source_id` em `placement`. Também
/// aditivo — não está em `BlockCommands` porque "colar bloco sincronizado" é
/// uma ação distinta de `create_block` genérico, não uma variação dele.
#[tauri::command]
pub async fn create_synced_block_copy(state: State<'_, AppState>, source_id: Uuid, placement: BlockPlacementInput) -> Result<BlockRow> {
    block_repository(&state)?.create_synced_copy(source_id, placement).await
}

/// Quantas cópias vivas apontam para `id` (resolvido ao original, se `id`
/// já for uma cópia) — o frontend consulta isso antes de mostrar o aviso do
/// EDT-078.
#[tauri::command]
pub async fn count_synced_copies(state: State<'_, AppState>, id: Uuid) -> Result<i64> {
    block_repository(&state)?.count_synced_copies(id).await
}

/// EDT-076: desconecta só esta cópia, preservando seu conteúdo atual.
#[tauri::command]
pub async fn unsync_block(state: State<'_, AppState>, id: Uuid) -> Result<BlockRow> {
    block_repository(&state)?.unsync_one(id).await
}

/// EDT-077: desconecta todas as cópias do original `id` de uma vez.
#[tauri::command]
pub async fn unsync_all_synced_copies(state: State<'_, AppState>, id: Uuid) -> Result<Vec<BlockRow>> {
    block_repository(&state)?.unsync_all(id).await
}

/// EDT-078: apaga o original `id` e, junto, todas as suas cópias. Acima do
/// limiar de aviso, exige `confirmed = true` — sem isso, devolve erro
/// descrevendo quantas cópias seriam apagadas, para o frontend mostrar a
/// confirmação antes de tentar de novo.
#[tauri::command]
pub async fn delete_synced_original(state: State<'_, AppState>, id: Uuid, confirmed: bool) -> Result<()> {
    block_repository(&state)?.delete_synced_original(id, confirmed).await
}
