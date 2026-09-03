-- Backs FUN-037 (global search): a generated column stays in sync with
-- `title` automatically, so no write path can forget to update the index.
-- pg_trgm on the raw title covers substring/typo-tolerant matching that
-- tsvector's word-based matching misses (e.g. matching "Bio" inside "Biologia").
ALTER TABLE pages ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('portuguese', coalesce(title, ''))) STORED;

CREATE INDEX idx_pages_search_vector ON pages USING GIN (search_vector);
CREATE INDEX idx_pages_title_trgm ON pages USING GIN (title gin_trgm_ops);
