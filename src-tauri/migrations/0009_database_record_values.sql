-- One row per (record, property) pair. A record is a page (pages.database_id
-- set); its property values live here instead of as columns on `pages`, so
-- adding a property is an INSERT into `database_properties`, never an ALTER
-- TABLE on a data table.
CREATE TABLE database_record_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
    -- Every property type's value fits jsonb (number, string, string[], bool,
    -- a date range, a file list, a relation's target id list); the property
    -- row says how to interpret it, so this table never needs a column per type.
    value JSONB NOT NULL DEFAULT 'null'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (record_id, property_id)
);

CREATE INDEX idx_database_record_values_record_id ON database_record_values (record_id);
CREATE INDEX idx_database_record_values_property_id ON database_record_values (property_id);
-- Filters, sorts, and rollups read the jsonb value itself; GIN with
-- jsonb_path_ops covers containment/equality lookups across every property
-- without a bespoke index per property.
CREATE INDEX idx_database_record_values_value ON database_record_values USING GIN (value jsonb_path_ops);

CREATE TRIGGER database_record_values_set_updated_at
    BEFORE UPDATE ON database_record_values
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
