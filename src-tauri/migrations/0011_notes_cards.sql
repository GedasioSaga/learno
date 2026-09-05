-- A note holds the content (field values); each of its note type's templates
-- produces one card. Scheduling state lives on the card, not the note,
-- because two cards from the same note can be at different points in review.
CREATE TABLE notes (
    id TEXT PRIMARY KEY NOT NULL,
    note_type_id TEXT NOT NULL REFERENCES note_types(id) ON DELETE RESTRICT,
    deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE RESTRICT,
    -- {"Frente": "...", "Verso": "..."}, keyed by note_types.fields.
    field_values TEXT NOT NULL DEFAULT '{}',
    -- Postgres tinha `TEXT[]` nativo; SQLite não tem tipo array (o contrato
    -- não cobre este caso — divergência registrada no relatório desta
    -- peça). Serializado como array JSON, pela mesma lógica de "sem tipo
    -- nativo, vira TEXT com JSON" que já vale para JSONB.
    tags TEXT NOT NULL DEFAULT '[]',
    -- INT-003: a live pointer to the block that originated this note, not a
    -- copy — editing that block's text keeps every card studying the current
    -- wording. NULL for a note created directly in the browser.
    source_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    -- INT-009: once source_block_id goes NULL (its block was deleted), the
    -- note keeps whatever text it had at that moment instead of losing content.
    source_text_frozen TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (json_valid(field_values)),
    CHECK (json_valid(tags))
) STRICT;

CREATE INDEX idx_notes_deck_id ON notes (deck_id);
CREATE INDEX idx_notes_note_type_id ON notes (note_type_id);
CREATE INDEX idx_notes_source_block_id ON notes (source_block_id) WHERE source_block_id IS NOT NULL;
-- O `GIN (tags)` do Postgres (containment de array) não tem equivalente
-- direto — ver `perdas`. Filtrar por tag em SQLite varre e usa
-- `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`, sem índice
-- dedicado; aceitável na escala de um app de estudo de um usuário só.

CREATE TRIGGER notes_set_updated_at
AFTER UPDATE ON notes
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE notes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TABLE cards (
    id TEXT PRIMARY KEY NOT NULL,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    -- Which of the note type's templates this card renders (0-based, like
    -- Anki's template ordinal) — a note with N templates yields N cards.
    template_ordinal INTEGER NOT NULL DEFAULT 0,
    deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE RESTRICT,
    -- 'new' | 'learning' | 'review' | 'relearning' | 'suspended'
    state TEXT NOT NULL DEFAULT 'new',
    due TEXT,
    -- Which scheduler produced the fields below — SM-2 and FSRS coexist per
    -- deck/preset (SRS-071 vs SRS-091), so a card must say which one it is under.
    scheduler TEXT NOT NULL DEFAULT 'sm2',
    interval_days INTEGER NOT NULL DEFAULT 0,
    -- SM-2 ease factor, stored as an integer times 100 (2500 = 2.50) so
    -- repeated multiplication never drifts the way a stored float would.
    ease_factor INTEGER NOT NULL DEFAULT 250,
    -- FSRS memory state; NULL until the card is scheduled under FSRS at least once.
    fsrs_stability REAL,
    fsrs_difficulty REAL,
    learning_step INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    is_leech INTEGER NOT NULL DEFAULT 0,
    flags INTEGER NOT NULL DEFAULT 0,
    suspended_at TEXT,
    buried_until TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (note_id, template_ordinal),
    CHECK (state IN ('new', 'learning', 'review', 'relearning', 'suspended')),
    CHECK (scheduler IN ('sm2', 'fsrs'))
) STRICT;

CREATE INDEX idx_cards_note_id ON cards (note_id);
-- The daily queue always filters by deck + state and orders by due
-- (SRS-042, PLT-017's 10k-card recompute), so this is the one index the
-- scheduler leans on.
CREATE INDEX idx_cards_deck_state_due ON cards (deck_id, state, due);

CREATE TRIGGER cards_set_updated_at
AFTER UPDATE ON cards
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE cards SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
