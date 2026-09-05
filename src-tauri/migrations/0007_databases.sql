-- Fase 3 foundation. A `databases` row is the database itself (its name and
-- lock state); it lives inline in a page or as that page's whole content
-- (DBS-001/002) via `container_page_id`. Its records are ordinary pages with
-- `pages.database_id` pointing back here, so a record inherits trash,
-- version history, and tree machinery for free instead of duplicating it.
CREATE TABLE databases (
    id TEXT PRIMARY KEY NOT NULL,
    container_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    -- DBS-002: locked blocks adding/removing properties and views, but never
    -- editing values — enforced by application logic, recorded here.
    is_locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX idx_databases_container_page_id ON databases (container_page_id);

CREATE TRIGGER databases_set_updated_at
AFTER UPDATE ON databases
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE databases SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Na versão Postgres, a FK de `pages.database_id` para `databases(id)` era
-- adicionada aqui via `ALTER TABLE ... ADD CONSTRAINT` — 0003 não podia
-- declará-la porque `databases` ainda não existia. Em SQLite não há esse
-- passo: 0003 já declara `database_id TEXT REFERENCES databases(id)`
-- diretamente (comentário lá explica por que isso funciona). Aqui só sobra
-- o índice, que continua fazendo sentido só a partir de agora que a FK que
-- ele apoia é significativa.
CREATE INDEX idx_pages_database_id ON pages (database_id) WHERE database_id IS NOT NULL;
