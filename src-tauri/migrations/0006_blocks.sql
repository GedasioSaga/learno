-- The live block tree a page is made of (Fase 2's editor). Blocks nest under
-- other blocks (toggles, callouts, columns), independent of the page tree
-- above, so `parent_block_id` is a second, block-scoped self-reference
-- rather than reusing `pages.parent_id`.
CREATE TABLE blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    parent_block_id UUID REFERENCES blocks(id) ON DELETE CASCADE,
    block_type TEXT NOT NULL,
    content JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Denormalized plain-text extract of `content`, kept in sync by whichever
    -- layer writes the block (the editor knows how to flatten its own JSON;
    -- the data layer does not parse every block type), so global search
    -- (FUN-037) has something uniform to index across all block types.
    plain_text TEXT NOT NULL DEFAULT '',
    -- EDT-073's "Turn into > Synced block": a synced copy points back at its
    -- original here. NULL for an ordinary block or for the original itself.
    synced_source_id UUID REFERENCES blocks(id) ON DELETE SET NULL,
    -- Fractional index among siblings sharing (page_id, parent_block_id) —
    -- same cheap-reorder rationale as pages.position.
    position TEXT NOT NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blocks_page_id ON blocks (page_id);
CREATE INDEX idx_blocks_parent_block_id ON blocks (parent_block_id);
CREATE INDEX idx_blocks_active_siblings ON blocks (page_id, parent_block_id, position) WHERE deleted_at IS NULL;
CREATE INDEX idx_blocks_synced_source_id ON blocks (synced_source_id) WHERE synced_source_id IS NOT NULL;

ALTER TABLE blocks ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('portuguese', coalesce(plain_text, ''))) STORED;
CREATE INDEX idx_blocks_search_vector ON blocks USING GIN (search_vector);

CREATE TRIGGER blocks_set_updated_at
    BEFORE UPDATE ON blocks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
