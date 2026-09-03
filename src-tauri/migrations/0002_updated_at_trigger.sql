-- One trigger function shared by every table with an `updated_at` column, so
-- "when was this last touched" (autosave conflict checks, DBS-026 Last
-- Edited Time, sync bookkeeping later) never depends on application code
-- remembering to set it on every write path.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
