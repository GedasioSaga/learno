//! Comandos `#[tauri::command]` que o frontend chama, e o estado compartilhado
//! entre eles.
//!
//! `db` já expõe os repositórios de página, histórico de versão e busca —
//! cada comando aqui monta o repositório certo a partir de `state.pool()` e
//! delega a ele; `import_apkg` delega da mesma forma a `anki::importar_pacote`.

// `pub(crate)` (não `mod` privado): `tauri::generate_handler!` em `lib.rs`
// referencia os comandos pelo caminho completo `ipc::commands::…` — a macro
// `#[tauri::command]` gera, ao lado de cada função, uma `macro_rules!` irmã
// que o `generate_handler!` também precisa enxergar, e isso só funciona pelo
// caminho original, não por um `pub use` que só reexporta a função.
pub(crate) mod backup_commands;
pub(crate) mod biblioteca_categorias_commands;
pub(crate) mod biblioteca_commands;
pub(crate) mod block_commands;
pub(crate) mod commands;
pub(crate) mod cronograma_commands;
pub(crate) mod database_commands;
pub(crate) mod deck_commands;
pub(crate) mod financas_commands;
pub(crate) mod formula_commands;
pub(crate) mod gamificacao_commands;
pub(crate) mod mindmap_commands;
pub(crate) mod pagina_de_livro_commands;
pub(crate) mod pomodoro_commands;
pub(crate) mod prazos_commands;
pub(crate) mod resumo_capitulo_commands;
pub(crate) mod study_commands;
pub(crate) mod trilha_commands;
pub(crate) mod vocabulario_commands;
mod state;

pub use backup_commands::{
    autosave_clear_pending, autosave_list_recoverable, autosave_merge_with_saved,
    autosave_write_pending, create_backup, default_export_file_name, export_page_markdown,
    get_backup_schedule_config, restore_backup, run_due_scheduled_backup,
    save_backup_schedule_config, trigger_backup_for_risky_operation,
};
pub use biblioteca_categorias_commands::{
    criar_categoria, definir_categorias_do_livro, listar_categorias, listar_categorias_do_livro,
    listar_categorias_por_livro, listar_livros_da_categoria, mover_categoria, remover_categoria, renomear_categoria,
};
pub use biblioteca_commands::{
    abrir_livro, criar_anotacao, definir_capa_do_livro, definir_metadados_do_livro, excluir_livro_definitivamente,
    importar_livro, listar_anotacoes, listar_livros, mover_livro, registrar_progresso, remover_livro,
};
pub use block_commands::{
    apply_block_changes, count_synced_copies, create_block, create_synced_block_copy,
    delete_blocks, delete_synced_original, list_all_tags, list_backlinks, list_outgoing_links,
    list_page_blocks, list_pages_for_tag, move_block, unsync_all_synced_copies, unsync_block, update_block,
};
pub use cronograma_commands::{
    aplicar_rotina, atualizar_bloco, atualizar_item_de_rotina, atualizar_materia, atualizar_rotina, copiar_semana,
    criar_bloco, criar_item_de_rotina, criar_materia, criar_rotina, definir_meta_semanal, listar_itens_de_rotina,
    listar_materias, listar_rotinas, mover_bloco, remover_bloco, remover_item_de_rotina, remover_materia,
    remover_rotina, semana_de_estudo,
};
pub use database_commands::{
    apply_record_value_changes, change_property_type, create_database, create_property, create_record, create_view,
    delete_database, delete_property, delete_view, get_database, list_databases_in_page, list_properties,
    list_records, list_views, rename_database, rename_property, rename_view, reorder_property, reorder_view,
    set_view_config,
};
pub use deck_commands::{
    create_deck, create_note, delete_deck, delete_note, get_deck_scheduling_options, list_decks, list_note_types,
    list_notes, rename_deck, set_deck_scheduling_options, update_note,
};
pub use commands::{
    check_database, create_page, create_page_version_snapshot, duplicate_page,
    get_app_config, get_data_dir, get_theme, open_workspace, get_page_breadcrumb, import_apkg, list_page_tree,
    list_page_versions, list_trashed_pages, move_page, permanently_delete_page, rename_page,
    restore_page, restore_page_version, save_data_dir, search_pages, set_page_favorite,
    save_theme, set_page_icon, trash_page,
};
pub use financas_commands::{
    atualizar_lancamento, atualizar_recorrente, confirmar_recorrente, criar_categoria_financas, criar_lancamento,
    criar_recorrente, encerrar_recorrente, listar_categorias_financas, listar_lancamentos_do_mes, listar_recorrentes,
    mudar_valor_recorrente, remover_lancamento, remover_recorrente, resumo_financeiro_do_mes,
    visao_financeira_por_meses,
};
pub use gamificacao_commands::{
    desafios_hoje, nivel_atual, recordes_pessoais, registrar_xp_bloco_cronograma, registrar_xp_desafio_diario,
    registrar_xp_pomodoro_concluido, registrar_xp_revisao_cartao, resumo_de_sessao, xp_total,
};
pub use mindmap_commands::{
    apply_mindmap_changes, create_mindmap, delete_mindmap, get_mindmap, list_mindmaps, rename_mindmap,
};
pub use pagina_de_livro_commands::{
    criar_pagina_de_livro, escrever_conteudo_da_pagina, listar_paginas_do_livro, mover_pagina_de_livro,
    remover_pagina_de_livro, renomear_pagina_de_livro,
};
pub use pomodoro_commands::{finish_pomodoro, pomodoro_today, start_pomodoro};
pub use prazos_commands::{atualizar_prazo, criar_prazo, listar_prazos, obter_prazo, remover_prazo};
pub use resumo_capitulo_commands::{listar_resumos_do_livro, remover_resumo_de_capitulo, salvar_resumo_de_capitulo};
pub use study_commands::{answer_card, deck_counts, deck_forecast, deck_maturity, next_card};
pub use vocabulario_commands::{
    atualizar_nota_da_palavra, coletar_palavra, listar_palavras, listar_palavras_do_livro, remover_palavra,
};
pub use state::AppState;
