-- FUN-044's backlink graph: an edge table populated by a trigger, not
-- derived at query time.
--
-- Deriving backlinks straight from `blocks.content` on every read (scan
-- every block, extract every `pageId` from its JSONB, filter by target)
-- would mean a full-table scan of `blocks` each time any page's "Backlinks"
-- section renders — no index reaches inside JSONB structure-agnostically.
-- An edge table turns that read into "the rows in this table whose
-- `target_page_id` is this page", answerable through the index below, at
-- the cost of keeping the table in sync on write.
--
-- A trigger (not application code in `db::blocks::BlockRepository`) is what
-- keeps it in sync, because it is the one thing guaranteed to run no matter
-- which code path writes a block's `content` — this repository's own
-- create/update, `db::pages`'s page-duplication copy (raw `INSERT`, no
-- repository call), a future importer. One trigger is one place that can
-- drift from `blocks.content`; N call sites remembering to also call a
-- "resync links" function is N places that can drift, and the mistake
-- (feature ships, someone forgets the call site) does not fail loudly.
--
-- The wire convention a block's `content` must follow to be discoverable
-- here: a JSON object anywhere inside `content`, at any nesting depth,
-- carrying a string field literally named `pageId` is a reference to that
-- page. This covers an inline "@mention" node buried inside a paragraph's
-- rich-text tree and a top-level "link to page" block's own content with
-- the exact same rule, so the editor never needs a second code path for
-- "how do I make this discoverable as a link". It is additional to
-- `contract.ts`'s `BlockContent` (still opaque, still
-- `Record<string, unknown>` — this migration does not change that type or
-- weaken "the data layer never parses it" for ordinary block CRUD, which
-- never runs this expression); it is a convention the editor's mention and
-- link-to-page node authors need to follow for FUN-044/045 to work, not a
-- schema change to what a block IS. See CHECKLIST.md FUN-043/044/045 and
-- the ressalvas in this session's report for the integration note.
CREATE TABLE block_page_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    -- Denormalized from the source block at write time so a backlinks query
    -- never has to join back through `blocks` just to know which page a hit
    -- lives on.
    source_page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    UNIQUE (source_block_id, target_page_id)
);

CREATE INDEX idx_block_page_links_target ON block_page_links (target_page_id);
CREATE INDEX idx_block_page_links_source_page ON block_page_links (source_page_id);

-- Recomputes every edge sourced from NEW unconditionally (delete-then-insert
-- rather than a diff) — content changes on every keystroke via autosave, a
-- block rarely carries more than a handful of links, and this keeps the
-- logic here to one obviously-correct pass instead of a diff that could
-- itself drift from the extraction rule above.
--
-- `target.id <> NEW.page_id` drops self-references (a page mentioning
-- itself) — a page's own backlinks section listing itself is noise, not a
-- feature anyone asked for, and FUN-044's criterion never exercises it.
--
-- The `~* '^[0-9a-f]{8}-...'` filter (rather than trying to CAST every
-- match and catching the exception) is what keeps a stray non-UUID string
-- that happens to sit under a `pageId` key, or a `pageId` referencing a
-- page since permanently deleted, from raising an error out of this trigger
-- and failing the block save that triggered it — it is filtered out of the
-- candidate set before the join to `pages` ever runs.
CREATE FUNCTION sync_block_page_links() RETURNS trigger AS $$
BEGIN
    DELETE FROM block_page_links WHERE source_block_id = NEW.id;

    IF NEW.deleted_at IS NULL THEN
        INSERT INTO block_page_links (source_block_id, source_page_id, target_page_id)
        SELECT DISTINCT NEW.id, NEW.page_id, target.id
        FROM jsonb_path_query(NEW.content, '$.**.pageId') AS raw_match
        CROSS JOIN LATERAL (SELECT trim(both '"' from raw_match::text) AS candidate) AS extracted
        JOIN pages target ON target.id::text = extracted.candidate
        WHERE extracted.candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND target.id <> NEW.page_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fires on `content`, `deleted_at` or `page_id` changing — the three
-- columns that can change which edges are correct (a soft-deleted block's
-- links must disappear; a block moved to another page must re-source its
-- edges from the new page). Any other column changing (position, block_type
-- alone, etc.) leaves the edge set untouched, so this does not run on every
-- unrelated write to the row.
CREATE TRIGGER blocks_sync_page_links
    AFTER INSERT OR UPDATE OF content, deleted_at, page_id ON blocks
    FOR EACH ROW EXECUTE FUNCTION sync_block_page_links();
