-- The live block tree a page is made of (Fase 2's editor). Blocks nest under
-- other blocks (toggles, callouts, columns), independent of the page tree
-- above, so `parent_block_id` is a second, block-scoped self-reference
-- rather than reusing `pages.parent_id`.
CREATE TABLE blocks (
    id TEXT PRIMARY KEY NOT NULL,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    parent_block_id TEXT REFERENCES blocks(id) ON DELETE CASCADE,
    block_type TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '{}',
    -- Denormalized plain-text extract of `content`, kept in sync by whichever
    -- layer writes the block (the editor knows how to flatten its own JSON;
    -- the data layer does not parse every block type), so global search
    -- (FUN-037) has something uniform to index across all block types.
    plain_text TEXT NOT NULL DEFAULT '',
    -- EDT-073's "Turn into > Synced block": a synced copy points back at its
    -- original here. NULL for an ordinary block or for the original itself.
    synced_source_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    -- Fractional index among siblings sharing (page_id, parent_block_id) —
    -- same cheap-reorder rationale as pages.position.
    position TEXT NOT NULL,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (json_valid(content))
) STRICT;

CREATE INDEX idx_blocks_page_id ON blocks (page_id);
CREATE INDEX idx_blocks_parent_block_id ON blocks (parent_block_id);
CREATE INDEX idx_blocks_active_siblings ON blocks (page_id, parent_block_id, position) WHERE deleted_at IS NULL;
CREATE INDEX idx_blocks_synced_source_id ON blocks (synced_source_id) WHERE synced_source_id IS NOT NULL;

CREATE TRIGGER blocks_set_updated_at
AFTER UPDATE ON blocks
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE blocks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Busca global sobre `plain_text` (FUN-037). Mesma colisão com 0015 que
-- 0004_page_search.sql documenta: FTS5 já nasce insensível a acento, então
-- não existe uma segunda migração de normalização a fazer depois — ver
-- `docs/MIGRACAO-SQLITE.md`.
CREATE VIRTUAL TABLE blocks_fts USING fts5(
    id UNINDEXED,
    plain_text,
    tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER blocks_fts_after_insert
AFTER INSERT ON blocks
BEGIN
    INSERT INTO blocks_fts (id, plain_text) VALUES (NEW.id, NEW.plain_text);
END;

CREATE TRIGGER blocks_fts_after_update
AFTER UPDATE OF plain_text ON blocks
BEGIN
    DELETE FROM blocks_fts WHERE id = OLD.id;
    INSERT INTO blocks_fts (id, plain_text) VALUES (NEW.id, NEW.plain_text);
END;

CREATE TRIGGER blocks_fts_after_delete
AFTER DELETE ON blocks
BEGIN
    DELETE FROM blocks_fts WHERE id = OLD.id;
END;
