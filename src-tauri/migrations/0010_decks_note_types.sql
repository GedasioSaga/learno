-- Fase 4 (SRS/Anki) foundation: decks and note types, independent of any
-- particular note so both can be created before the first flashcard exists.
CREATE TABLE decks (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    -- Scheduling options preset (learning/relearning steps, SM-2 ease/bonus/
    -- modifiers, FSRS desired retention, leech threshold+action, easy days,
    -- ...). Kept as one JSON blob shared by reference so editing a preset
    -- (Fase 6) updates every deck using it without a schema change.
    options TEXT NOT NULL DEFAULT '{}',
    position TEXT NOT NULL,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (json_valid(options))
) STRICT;

CREATE INDEX idx_decks_parent_id ON decks (parent_id);

CREATE TRIGGER decks_set_updated_at
AFTER UPDATE ON decks
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE decks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TABLE note_types (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    -- Field names in display order, e.g. ["Frente", "Verso", "Extra"].
    fields TEXT NOT NULL DEFAULT '[]',
    -- Card templates: [{name, front, back}], each front/back referencing
    -- {{FieldName}} placeholders — the same shape Anki uses, so .apkg
    -- import/export (PLT-004, SRS-149/150) needs no translation layer.
    templates TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (json_valid(fields)),
    CHECK (json_valid(templates))
) STRICT;

CREATE TRIGGER note_types_set_updated_at
AFTER UPDATE ON note_types
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE note_types SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
