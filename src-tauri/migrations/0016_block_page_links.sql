-- FUN-044's backlink graph: an edge table populated by a trigger, not
-- derived at query time.
--
-- Deriving backlinks straight from `blocks.content` on every read (scan
-- every block, extract every `pageId` from its JSON, filter by target)
-- would mean a full-table scan of `blocks` each time any page's "Backlinks"
-- section renders. An edge table turns that read into "the rows in this
-- table whose `target_page_id` is this page", answerable through the index
-- below, at the cost of keeping the table in sync on write.
--
-- A trigger (not application code in `db::blocks::BlockRepository`) is what
-- keeps it in sync, because it is the one thing guaranteed to run no matter
-- which code path writes a block's `content` — this repository's own
-- create/update, `db::pages`'s page-duplication copy (raw `INSERT`, no
-- repository call), a future importer. One trigger is one place that can
-- drift; N call sites remembering to also call a "resync links" function is
-- N places that can drift, and the mistake does not fail loudly.
--
-- The wire convention a block's `content` must follow to be discoverable
-- here: a JSON object anywhere inside `content`, at any nesting depth,
-- carrying a string field literally named `pageId` is a reference to that
-- page. Isso cobre a @-menção inline enterrada na árvore de texto rico de um
-- parágrafo e o bloco "link para página" com a MESMA regra.
--
-- Essa convenção já custou caro uma vez: na Fase 2 o nó de menção gravava a
-- chave como `id` (o `MentionNodeAttrs` do TipTap é sempre `{id, label}`) e
-- a extração procurava `pageId`, então nenhuma menção real gerava backlink —
-- e o teste que deveria ter pego fabricava um JSON com `pageId`, uma forma
-- que o cliente nunca produzia. Ver `docs/ACHADOS-FASE-2.md`. Quem mexer
-- aqui ou no nó de menção precisa manter as duas pontas com o MESMO nome.
CREATE TABLE block_page_links (
    id TEXT PRIMARY KEY NOT NULL,
    source_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    -- Denormalized from the source block at write time so a backlinks query
    -- never has to join back through `blocks` just to know which page a hit
    -- lives on.
    source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    UNIQUE (source_block_id, target_page_id)
) STRICT;

CREATE INDEX idx_block_page_links_target ON block_page_links (target_page_id);
CREATE INDEX idx_block_page_links_source_page ON block_page_links (source_page_id);

-- `json_tree(NEW.content)` é o equivalente exato de
-- `jsonb_path_query(NEW.content, '$.**.pageId')` do Postgres: percorre o JSON
-- inteiro recursivamente, uma linha por nó, com `key`, `value` e `type`. O
-- filtro `key = 'pageId' AND type = 'text'` é a regra de descoberta acima,
-- escrita em SQL comum.
--
-- DUAS COISAS QUE O POSTGRES PRECISAVA E AQUI SOMEM:
--
-- 1. O filtro por regex de UUID (`~* '^[0-9a-f]{8}-...'`) existia para uma
--    string qualquer sob uma chave `pageId` não estourar o `CAST` para uuid e
--    derrubar o save do bloco. Aqui `pages.id` é TEXT e a comparação é
--    TEXT com TEXT: uma string que não é id de página nenhuma simplesmente
--    não casa no JOIN. Nada a proteger, e SQLite não tem regex de qualquer
--    forma.
-- 2. O `IF NEW.deleted_at IS NULL ... END IF` do corpo plpgsql vira o
--    `WHERE NEW.deleted_at IS NULL` do próprio SELECT: um bloco na lixeira
--    faz o SELECT não produzir linha nenhuma, e o DELETE acima já tirou as
--    arestas antigas. Gatilho de SQLite só executa SQL comum, sem
--    condicional de fluxo.
--
-- `target.id <> NEW.page_id` descarta auto-referência (uma página mencionando
-- a si mesma): a seção de backlinks da própria página listando ela mesma é
-- ruído, e o critério de FUN-044 nunca exercita esse caso.
--
-- O id da aresta é gerado aqui com `hex(randomblob(16))` porque uma aresta
-- não tem dono do lado do cliente — diferente de bloco e registro, cujo id
-- vem do cliente por decisão da Fase 2. Não precisa ser UUID canônico: nada
-- fora desta tabela referencia esse id.

-- Recomputa toda aresta originada em NEW incondicionalmente
-- (apaga-e-insere, não diff) — `content` muda a cada tecla pelo autosave, um
-- bloco raramente carrega mais que um punhado de links, e assim a lógica
-- fica numa passada obviamente correta em vez de um diff que poderia
-- divergir da regra de extração.
CREATE TRIGGER blocks_sync_page_links_after_insert
AFTER INSERT ON blocks
BEGIN
    INSERT INTO block_page_links (id, source_block_id, source_page_id, target_page_id)
    SELECT DISTINCT hex(randomblob(16)), NEW.id, NEW.page_id, target.id
    FROM json_tree(NEW.content) AS jt
    JOIN pages target ON target.id = jt.value
    WHERE jt.key = 'pageId'
      AND jt.type = 'text'
      AND target.id <> NEW.page_id
      AND NEW.deleted_at IS NULL;
END;

-- Dispara em `content`, `deleted_at` ou `page_id` — as três colunas que
-- podem mudar quais arestas estão corretas (as arestas de um bloco na
-- lixeira somem; um bloco movido para outra página reorigina as suas).
-- Qualquer outra coluna mudando (position, block_type sozinho) deixa o
-- conjunto de arestas intacto, então isto não roda a cada escrita da linha.
CREATE TRIGGER blocks_sync_page_links_after_update
AFTER UPDATE OF content, deleted_at, page_id ON blocks
BEGIN
    DELETE FROM block_page_links WHERE source_block_id = NEW.id;

    INSERT INTO block_page_links (id, source_block_id, source_page_id, target_page_id)
    SELECT DISTINCT hex(randomblob(16)), NEW.id, NEW.page_id, target.id
    FROM json_tree(NEW.content) AS jt
    JOIN pages target ON target.id = jt.value
    WHERE jt.key = 'pageId'
      AND jt.type = 'text'
      AND target.id <> NEW.page_id
      AND NEW.deleted_at IS NULL;
END;
