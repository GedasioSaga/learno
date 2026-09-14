//! Learno — módulo raiz.
//!
//! Este arquivo é só fiação: declara os módulos, monta o `tauri::Builder` e
//! registra os comandos. Toda a lógica vive nos módulos abaixo, e cada um deles
//! é dono exclusivo dos seus arquivos:
//!
//! - `anki` — importação de pacotes `.apkg`/`.colpkg` do Anki.
//! - `config` — a pasta de trabalho onde o arquivo do banco vive. Não tem
//!   host, porta nem credencial: o banco é um arquivo local.
//! - `db` — o banco SQLite: pool, migrações e os repositórios de página,
//!   bloco, lixeira, histórico de versão, valor de propriedade e relação.
//! - `formula` — o motor de fórmula (léxico, sintaxe, tipo, avaliação),
//!   puro e sem nenhuma dependência de banco.
//! - `sidecar` — processo Python empacotado e o protocolo que fala com ele.
//! - `ipc` — os comandos `#[tauri::command]` que o frontend chama.
//! - `logs` — o log em arquivo (um por dia) e o registro de pânico.

pub mod anki;
pub mod backup;
pub mod config;
pub mod db;
pub mod error;
pub mod formula;
pub mod ipc;
pub mod logs;
pub mod rollup;
pub mod sidecar;
pub mod srs;

use tauri::Manager;

pub use error::{Error, Result};

/// Nome do evento de alternar tema.
///
/// A janela não tem mais barra de menu nativa — "Arquivo / Editar / Exibir /
/// Janela / Ajuda" era cromo do sistema operacional em cima de um app que
/// desenha a própria interface, e não oferecia nada que a UI já não tenha (o
/// alternador de tema mora na barra lateral, e os atalhos de edição são do
/// próprio WebView2, não do menu).
///
/// A constante fica porque o frontend ainda escuta este evento: é o gancho
/// para um atalho de teclado global ou para a bandeja do sistema, se um dia
/// houver. Sem ninguém emitindo, o ouvinte simplesmente nunca dispara.
pub const TOGGLE_THEME_EVENT: &str = "learno://toggle-theme";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        // EDT-028: cliente HTTP do lado Rust para buscar metadado de
        // bookmark (título/descrição/favicon) sem esbarrar em CORS — ver
        // src-tauri/capabilities/default.json para o escopo de URL.
        .plugin(tauri_plugin_http::init())
        // Auto-update pelo GitHub Releases: o frontend (AtualizadorBanner)
        // consulta o latest.json do endpoint em tauri.conf.json, baixa o
        // instalador assinado e reinicia pelo plugin-process.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Avisos do sistema: fim de fase do Pomodoro e lembrete de bloco do
        // Cronograma, disparados pelo frontend (`src/lib/notificacao.ts`).
        .plugin(tauri_plugin_notification::init())
        .manage(ipc::AppState::new())
        .setup(|app| {
            // O log liga aqui, e não no começo de `run`: a pasta de logs vem do
            // identificador do app, que só o `AppHandle` conhece.
            logs::iniciar(app.path().app_log_dir().ok().as_deref());

            // PLT-004: sobe o sidecar uma vez, aqui, e guarda o handle em
            // `AppState` para `import_apkg` (e as fases seguintes) chamarem.
            // Falha de spawn não é fatal para o app inteiro — só as features
            // que dependem do sidecar ficam indisponíveis até a próxima
            // abertura, então loga e segue em vez de propagar o erro.
            let handle = app.handle().clone();
            match sidecar::SidecarProcess::spawn(&handle) {
                Ok(process) => app.state::<ipc::AppState>().set_sidecar(process),
                Err(err) => tracing::error!(%err, "sidecar não iniciou"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::commands::get_app_config,
            ipc::commands::open_workspace,
            ipc::commands::get_data_dir,
            ipc::commands::encerrar_sidecar_para_atualizar,
            ipc::commands::save_data_dir,
            ipc::commands::get_theme,
            ipc::commands::save_theme,
            ipc::commands::import_apkg,
            ipc::commands::list_page_tree,
            ipc::commands::create_page,
            ipc::commands::rename_page,
            ipc::commands::set_page_favorite,
            ipc::commands::set_page_icon,
            ipc::commands::move_page,
            ipc::commands::duplicate_page,
            ipc::commands::trash_page,
            ipc::commands::restore_page,
            ipc::commands::permanently_delete_page,
            ipc::commands::list_trashed_pages,
            ipc::commands::get_page_breadcrumb,
            ipc::commands::list_page_versions,
            ipc::commands::restore_page_version,
            ipc::commands::create_page_version_snapshot,
            ipc::commands::search_pages,
            ipc::commands::check_database,
            // Os três comandos do motor de fórmula (arquitetura §9). Ficaram
            // fora desta lista — e fora do crate inteiro, já que `src/formula`
            // não era sequer declarado em `lib.rs` — desde que a peça F0 foi
            // escrita: o motor existia, com testes próprios, e nenhum byte
            // dele era compilado. É a mesma família de defeito que
            // `docs/ACHADOS-FASE-2.md` e `-FASE-3.md` já registram três vezes.
            ipc::formula_commands::validate_formula,
            ipc::formula_commands::preview_formula,
            ipc::formula_commands::list_formula_functions,
            // Avalia UMA propriedade de fórmula sobre TODOS os registros de
            // uma database numa chamada só — o que uma coluna de fórmula
            // numa tabela precisa para não chamar `preview_formula` uma vez
            // por linha.
            ipc::formula_commands::evaluate_formula_column,
            ipc::block_commands::list_page_blocks,
            ipc::block_commands::create_block,
            ipc::block_commands::update_block,
            ipc::block_commands::delete_blocks,
            ipc::block_commands::move_block,
            ipc::block_commands::apply_block_changes,
            ipc::block_commands::list_backlinks,
            ipc::block_commands::list_outgoing_links,
            ipc::block_commands::create_synced_block_copy,
            ipc::block_commands::count_synced_copies,
            ipc::block_commands::unsync_block,
            ipc::block_commands::unsync_all_synced_copies,
            ipc::block_commands::delete_synced_original,
            ipc::block_commands::list_all_tags,
            ipc::block_commands::list_pages_for_tag,
            ipc::deck_commands::list_decks,
            ipc::deck_commands::create_deck,
            ipc::deck_commands::rename_deck,
            ipc::deck_commands::delete_deck,
            ipc::deck_commands::list_note_types,
            ipc::deck_commands::create_note,
            ipc::deck_commands::update_note,
            ipc::deck_commands::delete_note,
            ipc::deck_commands::list_notes,
            ipc::deck_commands::get_deck_scheduling_options,
            ipc::deck_commands::set_deck_scheduling_options,
            ipc::mindmap_commands::list_mindmaps,
            ipc::mindmap_commands::create_mindmap,
            ipc::mindmap_commands::rename_mindmap,
            ipc::mindmap_commands::delete_mindmap,
            ipc::mindmap_commands::get_mindmap,
            ipc::mindmap_commands::apply_mindmap_changes,
            ipc::pomodoro_commands::start_pomodoro,
            ipc::pomodoro_commands::finish_pomodoro,
            ipc::pomodoro_commands::pomodoro_today,
            ipc::biblioteca_commands::listar_livros,
            ipc::biblioteca_commands::importar_livro,
            ipc::biblioteca_commands::abrir_livro,
            ipc::biblioteca_commands::registrar_progresso,
            ipc::biblioteca_commands::remover_livro,
            ipc::biblioteca_commands::excluir_livro_definitivamente,
            ipc::biblioteca_commands::definir_capa_do_livro,
            ipc::biblioteca_commands::definir_metadados_do_livro,
            ipc::biblioteca_commands::mover_livro,
            ipc::pagina_de_livro_commands::criar_pagina_de_livro,
            ipc::pagina_de_livro_commands::listar_paginas_do_livro,
            ipc::pagina_de_livro_commands::renomear_pagina_de_livro,
            ipc::pagina_de_livro_commands::escrever_conteudo_da_pagina,
            ipc::pagina_de_livro_commands::mover_pagina_de_livro,
            ipc::pagina_de_livro_commands::remover_pagina_de_livro,
            ipc::biblioteca_commands::listar_anotacoes,
            ipc::biblioteca_commands::criar_anotacao,
            ipc::resumo_capitulo_commands::salvar_resumo_de_capitulo,
            ipc::resumo_capitulo_commands::listar_resumos_do_livro,
            ipc::resumo_capitulo_commands::remover_resumo_de_capitulo,
            ipc::vocabulario_commands::coletar_palavra,
            ipc::vocabulario_commands::listar_palavras_do_livro,
            ipc::vocabulario_commands::listar_palavras,
            ipc::vocabulario_commands::atualizar_nota_da_palavra,
            ipc::vocabulario_commands::remover_palavra,
            ipc::biblioteca_categorias_commands::criar_categoria,
            ipc::biblioteca_categorias_commands::listar_categorias,
            ipc::biblioteca_categorias_commands::renomear_categoria,
            ipc::biblioteca_categorias_commands::remover_categoria,
            ipc::biblioteca_categorias_commands::definir_categorias_do_livro,
            ipc::biblioteca_categorias_commands::listar_categorias_do_livro,
            ipc::biblioteca_categorias_commands::listar_categorias_por_livro,
            ipc::biblioteca_categorias_commands::mover_categoria,
            ipc::biblioteca_categorias_commands::listar_livros_da_categoria,
            ipc::cronograma_commands::semana_de_estudo,
            ipc::cronograma_commands::definir_meta_semanal,
            ipc::cronograma_commands::criar_bloco,
            ipc::cronograma_commands::mover_bloco,
            ipc::cronograma_commands::atualizar_bloco,
            ipc::cronograma_commands::remover_bloco,
            ipc::cronograma_commands::criar_materia,
            ipc::cronograma_commands::listar_materias,
            ipc::cronograma_commands::atualizar_materia,
            ipc::cronograma_commands::remover_materia,
            ipc::cronograma_commands::copiar_semana,
            ipc::cronograma_commands::criar_rotina,
            ipc::cronograma_commands::listar_rotinas,
            ipc::cronograma_commands::atualizar_rotina,
            ipc::cronograma_commands::remover_rotina,
            ipc::cronograma_commands::criar_item_de_rotina,
            ipc::cronograma_commands::listar_itens_de_rotina,
            ipc::cronograma_commands::atualizar_item_de_rotina,
            ipc::cronograma_commands::remover_item_de_rotina,
            ipc::cronograma_commands::aplicar_rotina,
            ipc::prazos_commands::criar_prazo,
            ipc::prazos_commands::obter_prazo,
            ipc::prazos_commands::atualizar_prazo,
            ipc::prazos_commands::remover_prazo,
            ipc::prazos_commands::listar_prazos,
            ipc::financas_commands::listar_categorias_financas,
            ipc::financas_commands::criar_categoria_financas,
            ipc::financas_commands::criar_recorrente,
            ipc::financas_commands::listar_recorrentes,
            ipc::financas_commands::atualizar_recorrente,
            ipc::financas_commands::remover_recorrente,
            ipc::financas_commands::mudar_valor_recorrente,
            ipc::financas_commands::encerrar_recorrente,
            ipc::financas_commands::criar_lancamento,
            ipc::financas_commands::atualizar_lancamento,
            ipc::financas_commands::remover_lancamento,
            ipc::financas_commands::listar_lancamentos_do_mes,
            ipc::financas_commands::confirmar_recorrente,
            ipc::financas_commands::resumo_financeiro_do_mes,
            ipc::financas_commands::visao_financeira_por_meses,
            ipc::diagnostico_commands::registrar_erro_da_interface,
            ipc::diagnostico_commands::abrir_pasta_de_logs,
            ipc::database_commands::create_database,
            ipc::database_commands::get_database,
            ipc::database_commands::list_databases_in_page,
            ipc::database_commands::rename_database,
            ipc::database_commands::delete_database,
            ipc::database_commands::create_property,
            ipc::database_commands::list_properties,
            ipc::database_commands::rename_property,
            ipc::database_commands::change_property_type,
            ipc::database_commands::set_property_config,
            ipc::database_commands::reorder_property,
            ipc::database_commands::delete_property,
            ipc::database_commands::create_view,
            ipc::database_commands::list_views,
            ipc::database_commands::rename_view,
            ipc::database_commands::set_view_config,
            ipc::database_commands::reorder_view,
            ipc::database_commands::delete_view,
            ipc::database_commands::create_record,
            ipc::database_commands::list_records,
            ipc::database_commands::apply_record_value_changes,
            ipc::study_commands::deck_counts,
            ipc::study_commands::deck_maturity,
            ipc::study_commands::next_card,
            ipc::study_commands::answer_card,
            ipc::study_commands::deck_forecast,
            ipc::study_commands::study_stats,
            ipc::backup_commands::autosave_write_pending,
            ipc::backup_commands::autosave_clear_pending,
            ipc::backup_commands::autosave_list_recoverable,
            ipc::backup_commands::autosave_merge_with_saved,
            ipc::backup_commands::create_backup,
            ipc::backup_commands::restore_backup,
            ipc::backup_commands::export_page_markdown,
            ipc::backup_commands::default_export_file_name,
            ipc::backup_commands::get_backup_schedule_config,
            ipc::backup_commands::save_backup_schedule_config,
            ipc::backup_commands::run_due_scheduled_backup,
            ipc::backup_commands::trigger_backup_for_risky_operation,
            ipc::trilha_commands::obter_trilha,
            ipc::trilha_commands::criar_trilha,
            ipc::trilha_commands::listar_trilhas,
            ipc::trilha_commands::definir_propriedade_de_agrupamento_da_trilha,
            ipc::trilha_commands::criar_raia,
            ipc::trilha_commands::renomear_raia,
            ipc::trilha_commands::reordenar_raia,
            ipc::trilha_commands::definir_raia_recolhida,
            ipc::trilha_commands::remover_raia,
            ipc::trilha_commands::mover_etapa_para_raia,
            ipc::trilha_commands::marcar_progresso_etapa,
            ipc::trilha_commands::desmarcar_progresso_etapa,
            ipc::trilha_commands::etapa_esta_desbloqueada,
            ipc::trilha_commands::anexar_material_etapa,
            ipc::trilha_commands::remover_material_etapa,
            ipc::trilha_commands::criar_flecha,
            ipc::trilha_commands::apagar_flecha,
            ipc::trilha_commands::criar_trilha_completa,
            ipc::trilha_commands::criar_etapa,
            ipc::trilha_commands::remover_etapa,
            ipc::trilha_commands::marcar_etapa_como_decisao,
            ipc::trilha_commands::desmarcar_etapa_como_decisao,
            ipc::trilha_commands::escolher_caminho,
            ipc::trilha_commands::renomear_caminho,
            ipc::trilha_commands::prever_troca_de_caminho,
            ipc::gamificacao_commands::registrar_xp_revisao_cartao,
            ipc::gamificacao_commands::registrar_xp_pomodoro_concluido,
            ipc::gamificacao_commands::registrar_xp_bloco_cronograma,
            ipc::gamificacao_commands::desafios_hoje,
            ipc::gamificacao_commands::registrar_xp_desafio_diario,
            ipc::gamificacao_commands::xp_total,
            ipc::gamificacao_commands::nivel_atual,
            ipc::gamificacao_commands::recordes_pessoais,
            ipc::gamificacao_commands::resumo_de_sessao,
        ])
        .build(tauri::generate_context!());

    // Sem shutdown explícito do pool sqlx (`sqlx::PgPool` não precisa de um:
    // o processo inteiro cai junto), o sidecar é o único recurso externo que
    // precisa de encerramento explícito — um `CommandChild` vivo sobrevive ao
    // processo pai morrer no Windows até o handle ser fechado, então
    // `ExitRequested` mata o processo Python antes da janela fechar de vez.
    // `run` (em vez de `expect`) evita panic no caminho de falha de setup:
    // erro genuíno de plataforma (ex.: WebView2 ausente) vira mensagem de log
    // e saída com código de erro.
    match app {
        Ok(app) => app.run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Ok(process) = app_handle.state::<ipc::AppState>().sidecar() {
                    tauri::async_runtime::block_on(process.shutdown());
                }
            }
        }),
        Err(error) => {
            // O log só liga dentro do `setup`, que nunca rodou: o erro vai
            // direto para o stderr.
            eprintln!("falha ao inicializar o Tauri: {error}");
            std::process::exit(1);
        }
    }
}
