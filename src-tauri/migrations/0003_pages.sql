-- The page tree: every page (note, folder-like page, or database record —
-- see 0007_databases.sql) is one row here, at arbitrary nesting depth via
-- `parent_id`, so FUN-001's "no depth limit" is just "no CHECK constraint
-- capping it", not something the schema has to special-case.
--
-- `database_id` referencia `databases(id)` diretamente aqui, mesmo
-- `databases` só sendo criada em 0007 — na versão Postgres isso exigia
-- adiar a FK para um `ALTER TABLE ... ADD CONSTRAINT` em 0007, porque
-- Postgres valida a existência da tabela referenciada no momento do
-- `CREATE TABLE`. SQLite não valida: uma `REFERENCES` a uma tabela que
-- ainda não existe é aceita na criação e só é checada quando uma linha que
-- dependeria dela é de fato escrita — e isso só acontece depois que 0007
-- roda. Verificado (não assumido): `CREATE TABLE` com referência
-- adiantada funciona, um INSERT antes da tabela-alvo existir falha com
-- erro de SQL claro, e a cascata funciona normalmente depois que a
-- tabela-alvo existe. Isso elimina a necessidade do `ADD CONSTRAINT` que
-- 0007 fazia — SQLite nem tem essa forma de `ALTER TABLE`.
CREATE TABLE pages (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
    -- Set only for a page that is itself a database record.
    database_id TEXT REFERENCES databases(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    icon TEXT,
    -- Fractional index (hex string, see the `fractional_index` crate) among
    -- siblings sharing this `parent_id`. Drag-reorder (FUN-004) writes one
    -- row with a key between its two new neighbours; it never renumbers the
    -- rest of the list.
    position TEXT NOT NULL,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    -- NULL means active. Set means "in the trash" (FUN-027) without losing
    -- the row, so restore (FUN-029/030) has something to bring back.
    deleted_at TEXT,
    -- ISO 8601 UTC de largura fixa (`YYYY-MM-DDTHH:MM:SS.fffZ`) — a
    -- ordenação lexicográfica ser a cronológica é a invariante I5 da
    -- arquitetura da Fase 3, valendo para o banco inteiro desde a Fase 1.
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Every tree walk (breadcrumb, subtree listing, recursive duplicate/restore)
-- starts from a parent_id lookup.
CREATE INDEX idx_pages_parent_id ON pages (parent_id);
-- The sidebar/tree view always excludes trashed pages and orders by
-- position, so that predicate + sort earns its own partial index.
CREATE INDEX idx_pages_active_siblings ON pages (parent_id, position) WHERE deleted_at IS NULL;
CREATE INDEX idx_pages_deleted_at ON pages (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_pages_favorite ON pages (is_favorite) WHERE is_favorite AND deleted_at IS NULL;

-- Ver 0002_updated_at_trigger.sql: SQLite não tem função de gatilho
-- compartilhada, então cada tabela declara a sua. O `WHEN` evita rodar em
-- todo UPDATE (só quando quem chamou não setou `updated_at` sozinho) e
-- evita recursão infinita (a segunda passada já vê `NEW <> OLD`).
CREATE TRIGGER pages_set_updated_at
AFTER UPDATE ON pages
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE pages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
