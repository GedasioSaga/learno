-- Marca o DONO de uma página, pela raiz, em vez de inferir por heurística
-- estrutural a cada leitura (0003 nasceu sem essa noção; `PageRepository::list_tree`
-- vinha escondendo por forma — `database_id IS NOT NULL`, ou um FK de outra
-- tabela apontando para a página — e o comentário daquela função já admitia o
-- buraco: a página-CONTAINER da Trilha (`databases.container_page_id`) não tem
-- NADA no schema que a distinga de uma database que o próprio usuário monte
-- dentro de uma página de Notas. As duas têm exatamente a mesma forma.
--
-- `owner_section` fecha esse buraco por marcação direta em vez de inferência:
-- NULL (padrão) = página de Notas de verdade, do usuário — a leitura nunca
-- muda; um valor não-nulo = criada por aquela seção para uso próprio, nunca
-- deve aparecer na árvore de Notas. Cada seção grava o próprio valor
-- ('biblioteca', 'trilha', ...) na hora em que cria a página — ver
-- `PageRepository::create` (parâmetro novo, opcional) e o comando IPC
-- `create_page`. O CHECK trava a lista a valores conhecidos pelo mesmo motivo
-- de `library_books.format`: um valor novo entra por migração, nunca por um
-- INSERT distraído com typo silencioso.
--
-- `ALTER TABLE ... ADD COLUMN` simples, como em 0032: coluna nasce opcional
-- (sem `NOT NULL`), então não precisa do procedimento de 12 passos que uma
-- STRICT table exigiria para uma coluna obrigatória.
ALTER TABLE pages ADD COLUMN owner_section TEXT
    CHECK (owner_section IS NULL OR owner_section IN ('biblioteca', 'trilha'));

-- ---------------------------------------------------------------------------
-- Backfill: marca o que já existe hoje.
-- ---------------------------------------------------------------------------

-- Biblioteca: a página-identidade de cada livro já importado.
-- `library_books.page_id` (0022) é a mesma referência que
-- `PageRepository::list_tree` já usa para escondê-la por FK reversa — aqui só
-- vira coluna própria na página em vez de uma sub-consulta a cada leitura.
UPDATE pages SET owner_section = 'biblioteca'
WHERE id IN (SELECT page_id FROM library_books);

-- Trilha: a página-container de cada Trilha já criada.
-- Caminho: `databases.container_page_id` (0007, a página que HOSPEDA a
-- database) -> `database_views.database_id` (0008, as views daquela
-- database) -> `trail_views.view_id` (0023, 1:1 — a view É de Trilha).
--
-- Por que este backfill é exato HOJE, e por que quem religar a UI de
-- databases um dia precisa reler este comentário antes de confiar nele de
-- novo: nenhuma tela do app hoje permite ao usuário criar, na PRÓPRIA
-- database dele, uma view do tipo 'trail' — a UI de databases não chama IPC
-- nenhum ainda (dívida registrada em `src/lib/comandos-alcancaveis.test.ts`).
-- Logo, neste exato momento, TODA view com `view_type = 'trail'` que existe
-- no banco foi criada pela tela da Trilha (`TrilhaRepository::criar_trilha_completa`),
-- nunca por um usuário organizando sua própria database em Notas. O dia em
-- que a UI de databases ligar a criação de views e oferecer 'trail' como
-- opção para qualquer database, esta equivalência (view trail => container é
-- da Trilha) deixa de valer, e um backfill futuro não pode mais assumir isso
-- sem risco de marcar como "da Trilha" um container que o usuário fez.
UPDATE pages SET owner_section = 'trilha'
WHERE id IN (
    SELECT d.container_page_id
    FROM databases d
    JOIN database_views dv ON dv.database_id = d.id
    JOIN trail_views tv ON tv.view_id = dv.id
);
