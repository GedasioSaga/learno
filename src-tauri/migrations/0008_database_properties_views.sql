-- A database's schema (its properties/columns) and its saved views.
CREATE TABLE database_properties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    database_id UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- 'text' | 'number' | 'select' | 'multi_select' | 'status' | 'date' |
    -- 'checkbox' | 'url' | 'files' | 'formula' | 'relation' | 'rollup' |
    -- 'created_time' | 'last_edited_time' | ... Kept as text rather than an
    -- enum: Fase 6 keeps adding property types, and a CHECK can be widened
    -- in a migration without an enum-altering migration's extra ceremony.
    property_type TEXT NOT NULL,
    -- Type-specific shape: select options+colors, number display format, the
    -- formula expression, relation target database + one/two-way, rollup
    -- source property, etc.
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    position TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_database_properties_database_id ON database_properties (database_id, position);

CREATE TRIGGER database_properties_set_updated_at
    BEFORE UPDATE ON database_properties
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE database_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    database_id UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- 'table' | 'board' | 'list' | 'calendar' | 'gallery' | 'timeline'
    view_type TEXT NOT NULL,
    -- DBS-053: each view keeps its own filter/sort/group/visible-columns/
    -- column-order/column-widths, independent of every other view on the
    -- same database — one jsonb blob because it is always read and written
    -- as a single unit, never queried by sub-field.
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    position TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_database_views_database_id ON database_views (database_id, position);

CREATE TRIGGER database_views_set_updated_at
    BEFORE UPDATE ON database_views
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
