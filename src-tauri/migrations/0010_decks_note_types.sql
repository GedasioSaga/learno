-- Fase 4 (SRS/Anki) foundation: decks and note types, independent of any
-- particular note so both can be created before the first flashcard exists.
CREATE TABLE decks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id UUID REFERENCES decks(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    -- Scheduling options preset (learning/relearning steps, SM-2 ease/bonus/
    -- modifiers, FSRS desired retention, leech threshold+action, easy days,
    -- ...). Kept as one jsonb blob shared by reference so editing a preset
    -- (Fase 6) updates every deck using it without a schema change.
    options JSONB NOT NULL DEFAULT '{}'::jsonb,
    position TEXT NOT NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_decks_parent_id ON decks (parent_id);

CREATE TRIGGER decks_set_updated_at
    BEFORE UPDATE ON decks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE note_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    -- Field names in display order, e.g. ["Frente", "Verso", "Extra"].
    fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Card templates: [{name, front, back}], each front/back referencing
    -- {{FieldName}} placeholders — the same shape Anki uses, so .apkg
    -- import/export (PLT-004, SRS-149/150) needs no translation layer.
    templates JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER note_types_set_updated_at
    BEFORE UPDATE ON note_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
