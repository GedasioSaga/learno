-- A database's schema (its properties/columns) and its saved views.
CREATE TABLE database_properties (
    id TEXT PRIMARY KEY NOT NULL,
    database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
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
    config TEXT NOT NULL DEFAULT '{}',
    position TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (json_valid(config))
) STRICT;

CREATE INDEX idx_database_properties_database_id ON database_properties (database_id, position);

CREATE TRIGGER database_properties_set_updated_at
AFTER UPDATE ON database_properties
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE database_properties SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TABLE database_views (
    id TEXT PRIMARY KEY NOT NULL,
    database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- 'table' | 'board' | 'list' | 'calendar' | 'gallery' | 'timeline'
    view_type TEXT NOT NULL,
    -- DBS-053: each view keeps its own filter/sort/group/visible-columns/
    -- column-order/column-widths, independent of every other view on the
    -- same database — one blob because it is always read and written as a
    -- single unit, never queried by sub-field.
    config TEXT NOT NULL DEFAULT '{}',
    position TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (json_valid(config))
) STRICT;

CREATE INDEX idx_database_views_database_id ON database_views (database_id, position);

CREATE TRIGGER database_views_set_updated_at
AFTER UPDATE ON database_views
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE database_views SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
