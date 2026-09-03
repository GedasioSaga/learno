-- Fase 3 foundation. A `databases` row is the database itself (its name and
-- lock state); it lives inline in a page or as that page's whole content
-- (DBS-001/002) via `container_page_id`. Its records are ordinary pages with
-- `pages.database_id` pointing back here, so a record inherits trash,
-- version history, and tree machinery for free instead of duplicating it.
CREATE TABLE databases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    -- DBS-002: locked blocks adding/removing properties and views, but never
    -- editing values — enforced by application logic, recorded here.
    is_locked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_databases_container_page_id ON databases (container_page_id);

CREATE TRIGGER databases_set_updated_at
    BEFORE UPDATE ON databases
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deferred from 0003_pages.sql: only valid now that `databases` exists.
ALTER TABLE pages ADD CONSTRAINT fk_pages_database_id
    FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE;
CREATE INDEX idx_pages_database_id ON pages (database_id) WHERE database_id IS NOT NULL;
