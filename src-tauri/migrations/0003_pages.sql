-- The page tree: every page (note, folder-like page, or database record —
-- see 0007_databases.sql) is one row here, at arbitrary nesting depth via
-- `parent_id`, so FUN-001's "no depth limit" is just "no CHECK constraint
-- capping it", not something the schema has to special-case.
CREATE TABLE pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id UUID REFERENCES pages(id) ON DELETE SET NULL,
    -- Set only for a page that is itself a database record (FK added in
    -- 0007_databases.sql once `databases` exists — added here as a plain
    -- column to avoid a forward reference to a table that doesn't exist yet).
    database_id UUID,
    title TEXT NOT NULL DEFAULT '',
    icon TEXT,
    -- Fractional index (hex string, see the `fractional_index` crate) among
    -- siblings sharing this `parent_id`. Drag-reorder (FUN-004) writes one
    -- row with a key between its two new neighbours; it never renumbers the
    -- rest of the list.
    position TEXT NOT NULL,
    is_favorite BOOLEAN NOT NULL DEFAULT false,
    -- NULL means active. Set means "in the trash" (FUN-027) without losing
    -- the row, so restore (FUN-029/030) has something to bring back.
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every tree walk (breadcrumb, subtree listing, recursive duplicate/restore)
-- starts from a parent_id lookup.
CREATE INDEX idx_pages_parent_id ON pages (parent_id);
-- The sidebar/tree view always excludes trashed pages and orders by
-- position, so that predicate + sort earns its own partial index.
CREATE INDEX idx_pages_active_siblings ON pages (parent_id, position) WHERE deleted_at IS NULL;
CREATE INDEX idx_pages_deleted_at ON pages (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_pages_favorite ON pages (is_favorite) WHERE is_favorite AND deleted_at IS NULL;

CREATE TRIGGER pages_set_updated_at
    BEFORE UPDATE ON pages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
