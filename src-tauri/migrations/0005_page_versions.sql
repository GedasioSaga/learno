-- Version history (FUN-034/035/036). Deliberately independent of the
-- `blocks` table added next: a version is a frozen, opaque snapshot of
-- "what the page looked like", while `blocks` holds the live, editable
-- structure. Keeping them separate means restoring a version never has to
-- reverse-engineer block rows from a blob, and taking a snapshot never has
-- to understand every block type.
CREATE TABLE page_versions (
    id TEXT PRIMARY KEY NOT NULL,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    -- Whatever the editor considers "the document" at snapshot time (Fase 1
    -- has no block editor yet, so this may just mirror the title; Fase 2
    -- fills it with the real block-tree JSON without needing a new column).
    content TEXT NOT NULL DEFAULT '[]',
    -- 'autosave' (FUN-034 periodic capture), 'manual', or 'restore' — FUN-036
    -- restoring a version creates one of these too, so the timeline before
    -- the restore is never lost.
    reason TEXT NOT NULL DEFAULT 'autosave',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (reason IN ('autosave', 'manual', 'restore')),
    CHECK (json_valid(content))
) STRICT;

-- FUN-035 always lists one page's history newest-first.
CREATE INDEX idx_page_versions_page_id_created_at ON page_versions (page_id, created_at DESC);
