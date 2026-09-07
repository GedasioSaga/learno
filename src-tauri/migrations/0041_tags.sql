-- `#tag`s in a page's prose (see `src-tauri/src/db/tags.rs`'s doc comment
-- for the full "where does a tag live" reasoning — SQL trigger extraction,
-- the pattern `0016_block_page_links.sql` and `blocks_fts` both use, is not
-- an option here: recognizing `#materia/biologia` inside prose needs
-- Unicode-aware character classification and case folding SQLite's
-- expression language doesn't have, so extraction happens in Rust
-- (`db::tags::sync_block_tags`) and this migration is schema only, no
-- trigger).
--
-- Two tables, not one, and deliberately no `page_id` anywhere in
-- `block_tags`:
--
-- `tags` is the canonical, case-folded identity of a tag (`name` is
-- already lower-cased by the time it's written — see `extract_tags`'s
-- normalization — so `#Biologia` and `#biologia` are the same row).
--
-- `block_tags` is the edge, block to tag, recomputed in full
-- (delete-then-reinsert) every time `db::tags::sync_block_tags` runs for a
-- block — same non-diffing choice `block_page_links`'s trigger makes, for
-- the same reason (content changes on every keystroke, a block rarely
-- carries more than a handful of tags, and "recompute everything" is
-- obviously correct where a diff could quietly drift).
--
-- No `page_id` column here on purpose: which page a tagged block belongs to
-- is read live through the join to `blocks.page_id` on every query
-- (`TagRepository::list_all_tags`/`list_pages_for_tag`), not denormalized.
-- Denormalizing it (the way `block_page_links.source_page_id` is, for a
-- backlinks query's sake) would mean `BlockRepository::move_block` moving a
-- block to another page needs to also rewrite this table's stale `page_id`
-- — exactly the kind of second bookkeeping step this schema wants to avoid
-- needing. Reading it live costs one extra join per query and zero upkeep
-- code.
CREATE TABLE tags (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE block_tags (
    id TEXT PRIMARY KEY NOT NULL,
    block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    UNIQUE (block_id, tag_id)
) STRICT;

CREATE INDEX idx_block_tags_tag ON block_tags (tag_id);
CREATE INDEX idx_block_tags_block ON block_tags (block_id);
