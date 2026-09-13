#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Integration tests for `db::pages` contra um banco SQLite real.
//!
//! Nenhum teste aqui precisa de `#[ignore]`: cada um cria seu próprio
//! arquivo SQLite descartável via `support::IsolatedDatabase`, já migrado,
//! numa pasta temporária — então a suíte roda direto num `cargo test`
//! limpo, em qualquer máquina, sem cluster nenhum para subir antes. Isso
//! veio da migração para SQLite (`docs/MIGRACAO-SQLITE.md`); antes disso
//! era Postgres, com `LEARNO_TEST_DATABASE_URL` e `scripts/dev-db.ps1` como
//! pré-requisito. A lógica pura de que esses repositórios dependem
//! (`neighbours_for`, `resolve_restore_parent`, `duplicate_title`, e tudo em
//! `db::position`) continua coberta sem banco pelos módulos `#[cfg(test)]`
//! ao lado desse código em `src/db/`.

mod support;

use std::path::PathBuf;

use learno_lib::db::{
    BibliotecaRepository, DatabaseRepository, IdBind, MindmapRepository, PageRepository, SiblingPosition,
    TrilhaRepository,
};
use support::IsolatedDatabase;
use uuid::Uuid;

#[tokio::test]
async fn fun_001_arbitrary_depth_chain_keeps_correct_parent_ids() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let a = repo.create(None, "A").await.unwrap();
    let b = repo.create(Some(a.id), "B").await.unwrap();
    let c = repo.create(Some(b.id), "C").await.unwrap();

    assert_eq!(b.parent_id, Some(a.id));
    assert_eq!(c.parent_id, Some(b.id));

    let breadcrumb = repo.breadcrumb(c.id).await.unwrap();
    let titles: Vec<&str> = breadcrumb.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(titles, vec!["A", "B", "C"]);

    db.teardown().await;
}

#[tokio::test]
async fn fun_004_reordering_two_siblings_swaps_their_displayed_order() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let aula1 = repo.create(None, "Aula 1").await.unwrap();
    let aula2 = repo.create(None, "Aula 2").await.unwrap();

    repo.move_page(aula2.id, None, SiblingPosition::Start).await.unwrap();

    let tree = repo.list_tree(None).await.unwrap();
    let ids: Vec<_> = tree
        .into_iter()
        .filter(|p| p.id == aula1.id || p.id == aula2.id)
        .map(|p| p.id)
        .collect();
    assert_eq!(ids, vec![aula2.id, aula1.id]);

    db.teardown().await;
}

#[tokio::test]
async fn fun_020_duplicate_copies_children_without_touching_the_original() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let module = repo.create(None, "Módulo 1").await.unwrap();
    repo.create(Some(module.id), "Aula A").await.unwrap();
    repo.create(Some(module.id), "Aula B").await.unwrap();

    let copy = repo.duplicate(module.id).await.unwrap();
    assert_eq!(copy.title, "Módulo 1 (cópia)");
    assert_ne!(copy.id, module.id);

    let original_children = repo.list_tree(Some(module.id)).await.unwrap();
    let copy_children = repo.list_tree(Some(copy.id)).await.unwrap();
    assert_eq!(original_children.len(), 2);
    assert_eq!(copy_children.len(), 2);

    let original_ids: std::collections::HashSet<_> = original_children.iter().map(|p| p.id).collect();
    let copy_ids: std::collections::HashSet<_> = copy_children.iter().map(|p| p.id).collect();
    assert!(original_ids.is_disjoint(&copy_ids));

    db.teardown().await;
}

#[tokio::test]
async fn fun_027_trash_hides_a_page_from_the_active_tree_but_keeps_the_row() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let page = repo.create(None, "Rascunho Antigo").await.unwrap();
    let trashed = repo.trash(page.id).await.unwrap();
    assert!(trashed.deleted_at.is_some());

    let tree = repo.list_tree(None).await.unwrap();
    assert!(!tree.iter().any(|p| p.id == page.id));

    let fetched = repo.get(page.id).await.unwrap();
    assert!(fetched.deleted_at.is_some());

    db.teardown().await;
}

#[tokio::test]
async fn fun_029_restore_returns_the_page_to_its_original_parent() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let parent = repo.create(None, "Projetos").await.unwrap();
    let child = repo.create(Some(parent.id), "Rascunho Antigo").await.unwrap();
    repo.trash(child.id).await.unwrap();

    let restored = repo.restore(child.id).await.unwrap();
    assert_eq!(restored.parent_id, Some(parent.id));
    assert!(restored.deleted_at.is_none());

    db.teardown().await;
}

#[tokio::test]
async fn fun_030_restore_falls_back_to_root_when_the_original_parent_is_gone() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let parent = repo.create(None, "Aula X pai").await.unwrap();
    let child = repo.create(Some(parent.id), "Aula X").await.unwrap();
    repo.trash(child.id).await.unwrap();
    repo.trash(parent.id).await.unwrap();
    repo.permanently_delete(parent.id).await.unwrap();

    let restored = repo.restore(child.id).await.unwrap();
    assert_eq!(restored.parent_id, None);

    db.teardown().await;
}

#[tokio::test]
async fn fun_031_permanently_deleting_a_trashed_page_removes_the_row() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let page = repo.create(None, "Teste").await.unwrap();
    repo.trash(page.id).await.unwrap();
    repo.permanently_delete(page.id).await.unwrap();

    let result = repo.get(page.id).await;
    assert!(result.is_err());

    db.teardown().await;
}

#[tokio::test]
async fn permanently_deleting_an_active_page_is_rejected() {
    let db = IsolatedDatabase::setup("pages").await;
    let repo = PageRepository::new(db.pool.clone());

    let page = repo.create(None, "Ainda ativa").await.unwrap();
    let result = repo.permanently_delete(page.id).await;

    assert!(result.is_err());

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// A árvore de Notas mostra só o que é de Notas (achado desta peça: `list_tree`
// filtrava só por `deleted_at`, sem noção nenhuma de dono, e uma etapa da
// Trilha ou um livro da Biblioteca são páginas de verdade na mesma tabela).
//
// Cada teste abaixo usa o repositório de PRODUÇÃO da seção dona (`TrilhaRepository`,
// `DatabaseRepository`, `BibliotecaRepository`) para criar a página exatamente
// como o app cria hoje — nenhum SQL cru simulando "como seria" — e depois lê de
// volta com `PageRepository::list_tree`/`list_trash`, o mesmo par que a árvore
// de Notas e a Lixeira usam.
// ---------------------------------------------------------------------------

/// Um arquivo `.pdf` de verdade em disco, absoluto, não vazio — o mínimo que
/// `BibliotecaRepository::import` aceita (ver `validate_source_path` em
/// `db::biblioteca`). Cada chamador usa uma pasta própria para não colidir
/// com outro teste rodando em paralelo.
fn escreve_arquivo_fonte_pdf(rotulo: &str) -> (PathBuf, PathBuf) {
    let data_dir = std::env::temp_dir().join(format!("learno-list-tree-{rotulo}-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let origem = data_dir.join("Livro de Teste.pdf");
    std::fs::write(&origem, b"conteudo de pdf de teste").unwrap();
    (data_dir, origem)
}

#[tokio::test]
async fn list_tree_hides_trilha_etapas_and_database_records_and_templates_but_keeps_real_notes_pages() {
    let db = IsolatedDatabase::setup("pages").await;
    let pages = PageRepository::new(db.pool.clone());
    let trilha = TrilhaRepository::new(db.pool.clone());
    let databases = DatabaseRepository::new(db.pool.clone());

    // Uma sub-página de Notas de verdade, aninhada duas vezes — TEM que
    // continuar aparecendo, em qualquer profundidade (item 3 do pedido: "o
    // filtro é sobre DONO, não sobre profundidade").
    let raiz = pages.create(None, "Biologia").await.unwrap();
    let filha = pages.create(Some(raiz.id), "Aula 1").await.unwrap();
    let neta = pages.create(Some(filha.id), "Anotações da Aula 1").await.unwrap();

    // A Trilha: mesma sequência que `features/trilha/store.ts` vai passar a
    // executar (`createPage(null, "Trilha", "trilha")` seguido de
    // `criarTrilhaCompleta`) assim que a store for atualizada para passar o
    // novo argumento opcional — `create_with_owner` é o lado Rust já pronto
    // para receber essa chamada.
    let container_da_trilha = pages.create_with_owner(None, "Trilha", "trilha").await.unwrap();
    let trilha_criada = trilha
        .criar_trilha_completa(container_da_trilha.id, "Estudos", "Trilha", None)
        .await
        .unwrap();
    let etapa = trilha
        .criar_etapa(trilha_criada.trilha.configuracao.view_id, "Teste", "")
        .await
        .unwrap();

    // Uma database GENÉRICA que o próprio usuário monta dentro de uma página
    // de Notas (o caso que `create_database`/`create_record` também servem,
    // fora de qualquer seção dedicada) — o container é uma página de Notas de
    // verdade e precisa continuar visível; o registro dela, não.
    let container_generico = pages.create(None, "Minha lista de tarefas").await.unwrap();
    let database_generica = databases.create_database(container_generico.id, "Tarefas").await.unwrap();
    let registro_generico = databases.create_record(database_generica.id, "Tarefa 1").await.unwrap();

    // Um template daquela mesma database (DBS-103, 0020): página com
    // `is_template = 1`, sempre com `database_id` preenchido (confirmado
    // pelo próprio índice parcial `idx_pages_templates` da migração) — sem
    // repositório de template ainda, então esta é a única forma de produzir
    // uma linha dessas hoje.
    let template_id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, database_id, title, position, is_template) VALUES ($1, $2, 'Modelo', 'a0', 1)")
        .bind(template_id.db())
        .bind(database_generica.id.db())
        .execute(&db.pool)
        .await
        .unwrap();

    let arvore = pages.list_tree(None).await.unwrap();
    let ids: std::collections::HashSet<Uuid> = arvore.iter().map(|p| p.id).collect();

    assert!(ids.contains(&raiz.id), "página raiz de Notas precisa aparecer");
    assert!(ids.contains(&filha.id), "sub-página de Notas precisa aparecer");
    assert!(ids.contains(&neta.id), "sub-sub-página de Notas precisa aparecer, mesmo duas camadas fundo");
    assert!(
        ids.contains(&container_generico.id),
        "a página que hospeda uma database do usuário continua sendo uma página de Notas"
    );

    assert!(!ids.contains(&etapa.id), "etapa da Trilha não pode aparecer na árvore de Notas");
    assert!(!ids.contains(&registro_generico.id), "registro de uma database não é uma página de Notas");
    assert!(!ids.contains(&template_id), "template de uma database não é uma página de Notas");

    // O achado que motivou esta peça, agora corrigido: a página-container da
    // PRÓPRIA Trilha some da árvore de Notas porque nasceu marcada
    // (`owner_section = 'trilha'`), não por nenhuma inferência sobre a
    // database ou a view dentro dela.
    assert!(
        !ids.contains(&container_da_trilha.id),
        "a página-container da Trilha, marcada na criação, não pode aparecer na árvore de Notas"
    );

    db.teardown().await;
}

/// A regressão que o desenho anterior temia, e o motivo de `owner_section`
/// existir em vez de inferir o dono pela presença de uma view `trail`: o
/// usuário é livre para configurar, na PRÓPRIA database que montou em Notas,
/// uma view do tipo Trilha — a UI de databases ainda não oferece isso
/// (`src/lib/comandos-alcancaveis.test.ts`), então esta view nasce por SQL
/// direto, simulando o dia em que oferecer. Sem marcação, a página continua
/// sendo dela.
#[tokio::test]
async fn list_tree_keeps_a_users_own_database_with_a_trail_view() {
    let db = IsolatedDatabase::setup("pages").await;
    let pages = PageRepository::new(db.pool.clone());
    let databases = DatabaseRepository::new(db.pool.clone());

    let container = pages.create(None, "Minha organização pessoal").await.unwrap();
    let database = databases.create_database(container.id, "Organização").await.unwrap();

    let view_id = Uuid::now_v7();
    sqlx::query("INSERT INTO database_views (id, database_id, name, view_type, position) VALUES ($1, $2, 'Minha trilha', 'trail', 'a0')")
        .bind(view_id.db())
        .bind(database.id.db())
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO trail_views (view_id) VALUES ($1)")
        .bind(view_id.db())
        .execute(&db.pool)
        .await
        .unwrap();

    let ids: std::collections::HashSet<Uuid> = pages.list_tree(None).await.unwrap().into_iter().map(|p| p.id).collect();
    assert!(
        ids.contains(&container.id),
        "uma view do tipo trail dentro da PRÓPRIA database do usuário não pode escondê-la — só owner_section esconde"
    );

    db.teardown().await;
}

/// O filtro esconde por DONO, e nada mais.
///
/// Um filtro de visibilidade é fácil de acertar no caso que motivou a queixa e
/// errar num vizinho: bastaria a condição encostar em `is_favorite`,
/// `parent_id` ou profundidade para uma página do usuário sumir sem aviso —
/// e sumir é pior que aparecer demais, porque ele não sabe o que procurar.
#[tokio::test]
async fn list_tree_keeps_favorited_and_deeply_nested_notes_pages() {
    let db = IsolatedDatabase::setup("pages").await;
    let pages = PageRepository::new(db.pool.clone());

    let raiz = pages.create(None, "Curso").await.unwrap();
    let filha = pages.create(Some(raiz.id), "Módulo 1").await.unwrap();
    let neta = pages.create(Some(filha.id), "Aula 1").await.unwrap();
    let favorita = pages.create(None, "Favorita").await.unwrap();
    pages.set_favorite(favorita.id, true).await.unwrap();

    let ids: Vec<_> = pages.list_tree(None).await.unwrap().into_iter().map(|p| p.id).collect();

    assert!(ids.contains(&raiz.id), "página raiz de Notas precisa continuar visível");
    assert!(ids.contains(&filha.id), "sub-página precisa continuar visível");
    assert!(ids.contains(&neta.id), "sub-página aninhada em dois níveis precisa continuar visível");
    assert!(ids.contains(&favorita.id), "favoritar uma página não pode escondê-la da árvore");

    db.teardown().await;
}

#[tokio::test]
async fn list_tree_hides_a_biblioteca_book_page() {
    let db = IsolatedDatabase::setup("pages").await;
    let pages = PageRepository::new(db.pool.clone());
    let biblioteca = BibliotecaRepository::new(db.pool.clone());

    let raiz = pages.create(None, "Notas normais").await.unwrap();

    let (data_dir, origem) = escreve_arquivo_fonte_pdf("livro-oculto");
    let media_dir = data_dir.join("media");
    let entrada = biblioteca.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

    let arvore = pages.list_tree(None).await.unwrap();
    let ids: std::collections::HashSet<Uuid> = arvore.iter().map(|p| p.id).collect();

    assert!(ids.contains(&raiz.id), "página de Notas continua aparecendo");
    assert!(!ids.contains(&entrada.livro.page_id), "a página-identidade de um livro não é uma página de Notas");

    // Escondida da árvore, mas não escondida do app: a tela do livro abre a
    // página normalmente por `get`, que não filtra por dono — só `list_tree`
    // filtra.
    let pagina_do_livro = pages.get(entrada.livro.page_id).await.unwrap();
    assert_eq!(pagina_do_livro.id, entrada.livro.page_id, "a página do livro continua abrindo por get");

    let _ = std::fs::remove_dir_all(&data_dir);
    db.teardown().await;
}

#[tokio::test]
async fn list_tree_keeps_a_page_that_a_standalone_mindmap_merely_points_to() {
    let db = IsolatedDatabase::setup("pages").await;
    let pages = PageRepository::new(db.pool.clone());
    let mindmaps = MindmapRepository::new(db.pool.clone());

    // Mapa mental avulso (0025): o vínculo é OPCIONAL e na direção contrária
    // — do mapa PARA a página, nunca o mapa criando uma página seguindo o
    // padrão da Trilha/Biblioteca. A página apontada continua sendo, em
    // todo sentido, uma página de Notas comum.
    let pagina_apontada = pages.create(None, "Célula").await.unwrap();
    mindmaps.create("Mapa de Biologia", Some(pagina_apontada.id)).await.unwrap();

    let arvore = pages.list_tree(None).await.unwrap();
    assert!(
        arvore.iter().any(|p| p.id == pagina_apontada.id),
        "uma página apenas REFERENCIADA por um mapa mental continua sendo página de Notas"
    );

    db.teardown().await;
}

#[tokio::test]
async fn a_trilha_etapa_and_a_biblioteca_livro_still_open_through_get_even_though_the_notes_tree_hides_them() {
    let db = IsolatedDatabase::setup("pages").await;
    let pages = PageRepository::new(db.pool.clone());
    let trilha = TrilhaRepository::new(db.pool.clone());
    let biblioteca = BibliotecaRepository::new(db.pool.clone());

    let container_da_trilha = pages.create(None, "Trilha").await.unwrap();
    let trilha_criada = trilha
        .criar_trilha_completa(container_da_trilha.id, "Estudos", "Trilha", None)
        .await
        .unwrap();
    let etapa = trilha
        .criar_etapa(trilha_criada.trilha.configuracao.view_id, "Teste", "")
        .await
        .unwrap();

    let (data_dir, origem) = escreve_arquivo_fonte_pdf("livro-abre-por-conta");
    let media_dir = data_dir.join("media");
    let entrada = biblioteca.import(&media_dir, &origem.to_string_lossy()).await.unwrap();

    // Requisito 3 do pedido: sumir da árvore de Notas não pode virar sumir do
    // app — a página do registro precisa continuar legível pelo caminho da
    // própria seção, que por baixo é sempre `PageRepository::get`.
    let etapa_lida = pages.get(etapa.id).await.unwrap();
    assert_eq!(etapa_lida.title, "Teste");
    assert!(etapa_lida.deleted_at.is_none());

    let livro_lido = pages.get(entrada.livro.page_id).await.unwrap();
    assert_eq!(livro_lido.title, "Livro de Teste");
    assert!(livro_lido.deleted_at.is_none());

    let _ = std::fs::remove_dir_all(&data_dir);
    db.teardown().await;
}

#[tokio::test]
async fn list_trash_keeps_showing_a_trashed_trilha_etapa_and_a_trashed_biblioteca_livro() {
    let db = IsolatedDatabase::setup("pages").await;
    let pages = PageRepository::new(db.pool.clone());
    let trilha = TrilhaRepository::new(db.pool.clone());
    let biblioteca = BibliotecaRepository::new(db.pool.clone());

    let container_da_trilha = pages.create(None, "Trilha").await.unwrap();
    let trilha_criada = trilha
        .criar_trilha_completa(container_da_trilha.id, "Estudos", "Trilha", None)
        .await
        .unwrap();
    let etapa = trilha
        .criar_etapa(trilha_criada.trilha.configuracao.view_id, "Teste", "")
        .await
        .unwrap();
    pages.trash(etapa.id).await.unwrap();

    let (data_dir, origem) = escreve_arquivo_fonte_pdf("livro-na-lixeira");
    let media_dir = data_dir.join("media");
    let entrada = biblioteca.import(&media_dir, &origem.to_string_lossy()).await.unwrap();
    biblioteca.move_to_trash(entrada.livro.id).await.unwrap();

    // Decisão desta peça, documentada no comentário de `list_trash`: nem
    // Trilha nem Biblioteca têm tela de lixeira própria hoje, então a Lixeira
    // de Notas continua sendo o único caminho para restaurar ou excluir de
    // vez essas páginas — escondê-las aqui as tornaria irrecuperáveis pela
    // UI, o que é pior do que a confusão cosmética que o pedido descreveu.
    let lixeira = pages.list_trash().await.unwrap();
    let ids: std::collections::HashSet<Uuid> = lixeira.iter().map(|p| p.id).collect();
    assert!(ids.contains(&etapa.id), "etapa apagada precisa continuar restaurável pela Lixeira de Notas");
    assert!(
        ids.contains(&entrada.livro.page_id),
        "livro apagado precisa continuar restaurável pela Lixeira de Notas"
    );

    // E, claro, nenhuma das duas volta a poluir a árvore ATIVA.
    let arvore = pages.list_tree(None).await.unwrap();
    assert!(!arvore.iter().any(|p| p.id == etapa.id));
    assert!(!arvore.iter().any(|p| p.id == entrada.livro.page_id));

    let _ = std::fs::remove_dir_all(&data_dir);
    db.teardown().await;
}

#[tokio::test]
async fn list_tree_filters_records_created_before_this_fix_with_no_backfill_needed() {
    // Prova que a escolha (a) desta peça — filtrar na LEITURA, sem coluna
    // nova nem migração — limpa dado que já existia no banco, não só dado
    // criado depois. Simula "o usuário já tinha etapas e livros criados"
    // inserindo direto por SQL, exatamente como as linhas de produção já
    // gravadas por uma versão anterior do app estão hoje: mesma forma,
    // nenhuma coluna a mais.
    let db = IsolatedDatabase::setup("pages").await;
    let pages = PageRepository::new(db.pool.clone());

    let container_id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, title, position) VALUES ($1, 'Trilha antiga', 'a0')")
        .bind(container_id.db())
        .execute(&db.pool)
        .await
        .unwrap();
    let database_id = Uuid::now_v7();
    sqlx::query("INSERT INTO databases (id, container_page_id, name) VALUES ($1, $2, 'Estudos antigos')")
        .bind(database_id.db())
        .bind(container_id.db())
        .execute(&db.pool)
        .await
        .unwrap();
    let etapa_antiga_id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, database_id, title, position) VALUES ($1, $2, 'Etapa antiga', 'a0')")
        .bind(etapa_antiga_id.db())
        .bind(database_id.db())
        .execute(&db.pool)
        .await
        .unwrap();

    let arvore = pages.list_tree(None).await.unwrap();
    assert!(
        !arvore.iter().any(|p| p.id == etapa_antiga_id),
        "dado antigo, gravado antes desta correção, sai da árvore sem precisar de backfill"
    );

    db.teardown().await;
}

// ---------------------------------------------------------------------------
// O backfill de `0034_dono_da_pagina.sql` — prova sobre dado que já existia
// ANTES da coluna nascer, não sobre dado criado depois (que já é coberto
// pelos testes acima, via `create_with_owner`).
// ---------------------------------------------------------------------------

/// Remove todo comentário de linha (`-- ...`) de um arquivo `.sql` de
/// migração e devolve os statements restantes, um por elemento — para
/// aplicar `0034_dono_da_pagina.sql` sozinha, sem o resto da suíte de
/// migrações, no teste abaixo. Ingênuo de propósito (`split(';')` sem
/// entender string literal): funciona porque nenhum statement desta
/// migração tem `;` dentro de uma string, e quebraria alto (statement
/// SQL inválido) se um dia tivesse — não silenciosamente.
fn statements_da_migracao(sql: &str) -> Vec<String> {
    let sem_comentarios: String = sql
        .lines()
        .filter(|linha| !linha.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");

    sem_comentarios
        .split(';')
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
        .map(str::to_string)
        .collect()
}

/// Um banco migrado só até IMEDIATAMENTE ANTES de `0034_dono_da_pagina.sql`
/// — para o teste abaixo inserir dado "como uma versão anterior do app já
/// teria gravado" e só então aplicar 0034 sozinha por cima.
///
/// `sqlx::migrate!()` (o que `IsolatedDatabase`/`connect_and_migrate` usam)
/// é uma MACRO: embute toda migração da pasta em tempo de COMPILAÇÃO dentro
/// de um `Migrator` `static`, e não existe parâmetro "pare antes da versão
/// N" nesse `Migrator` embutido — pedir isso a ele exigiria um segundo
/// binário compilado contra uma pasta de migrações truncada, fora de
/// alcance de um teste de integração comum. O contorno: `sqlx::migrate::
/// Migrator::new` tem uma segunda forma, que lê o diretório do disco em
/// tempo de EXECUÇÃO (sem macro) — aplicada aqui contra uma cópia de
/// `migrations/` com o arquivo 0034 removido.
async fn banco_migrado_ate_antes_de_0034(label: &str) -> (sqlx::SqlitePool, PathBuf, PathBuf) {
    let db_path = std::env::temp_dir().join(format!("learno-{label}-{}.sqlite", Uuid::new_v4().simple()));
    let migrations_reais = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let migrations_truncadas = std::env::temp_dir().join(format!("learno-migrations-sem-0034-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&migrations_truncadas).unwrap();

    for entrada in std::fs::read_dir(&migrations_reais).unwrap() {
        let entrada = entrada.unwrap();
        let nome = entrada.file_name();
        if nome.to_string_lossy().starts_with("0034_") {
            continue;
        }
        std::fs::copy(entrada.path(), migrations_truncadas.join(&nome)).unwrap();
    }

    let opcoes = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().connect_with(opcoes).await.unwrap();

    let migrator = sqlx::migrate::Migrator::new(migrations_truncadas.clone()).await.unwrap();
    migrator.run(&pool).await.unwrap();

    (pool, db_path, migrations_truncadas)
}

#[tokio::test]
async fn migracao_0034_marca_dono_de_paginas_que_ja_existiam_no_backfill() {
    let (pool, db_path, migrations_truncadas) = banco_migrado_ate_antes_de_0034("migracao-0034").await;

    // Dado "legado": um livro da Biblioteca, uma Trilha completa (container +
    // database + view trail), e uma página comum de Notas — tudo gravado
    // ANTES de `owner_section` existir, exatamente como o parque de usuários
    // reais está hoje.
    let livro_page_id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, title, position) VALUES ($1, 'Livro antigo', 'a0')")
        .bind(livro_page_id.db())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO library_books (id, page_id, format, content_hash, file_name, original_file_name, file_size) \
         VALUES ($1, $2, 'pdf', $3, 'a.pdf', 'Livro Antigo.pdf', 100)",
    )
    .bind(Uuid::now_v7().db())
    .bind(livro_page_id.db())
    .bind("a".repeat(64))
    .execute(&pool)
    .await
    .unwrap();

    let container_id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, title, position) VALUES ($1, 'Trilha antiga', 'a1')")
        .bind(container_id.db())
        .execute(&pool)
        .await
        .unwrap();
    let database_id = Uuid::now_v7();
    sqlx::query("INSERT INTO databases (id, container_page_id, name) VALUES ($1, $2, 'Estudos')")
        .bind(database_id.db())
        .bind(container_id.db())
        .execute(&pool)
        .await
        .unwrap();
    let view_id = Uuid::now_v7();
    sqlx::query("INSERT INTO database_views (id, database_id, name, view_type, position) VALUES ($1, $2, 'Trilha', 'trail', 'a0')")
        .bind(view_id.db())
        .bind(database_id.db())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO trail_views (view_id) VALUES ($1)")
        .bind(view_id.db())
        .execute(&pool)
        .await
        .unwrap();

    let pagina_comum_id = Uuid::now_v7();
    sqlx::query("INSERT INTO pages (id, title, position) VALUES ($1, 'Notas comuns', 'a2')")
        .bind(pagina_comum_id.db())
        .execute(&pool)
        .await
        .unwrap();

    // Aplica 0034 sozinha, lendo o MESMO arquivo que roda em produção.
    let sql_0034 = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations/0034_dono_da_pagina.sql"),
    )
    .unwrap();
    for statement in statements_da_migracao(&sql_0034) {
        sqlx::query(&statement).execute(&pool).await.unwrap();
    }

    async fn owner_section_de(pool: &sqlx::SqlitePool, id: Uuid) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>("SELECT owner_section FROM pages WHERE id = $1")
            .bind(id.db())
            .fetch_one(pool)
            .await
            .unwrap()
    }

    assert_eq!(
        owner_section_de(&pool, livro_page_id).await,
        Some("biblioteca".to_string()),
        "backfill precisa marcar a página de um livro que já existia"
    );
    assert_eq!(
        owner_section_de(&pool, container_id).await,
        Some("trilha".to_string()),
        "backfill precisa marcar o container de uma Trilha que já existia"
    );
    assert_eq!(
        owner_section_de(&pool, pagina_comum_id).await,
        None,
        "backfill não pode marcar uma página comum de Notas"
    );

    pool.close().await;
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_dir_all(&migrations_truncadas);
}
