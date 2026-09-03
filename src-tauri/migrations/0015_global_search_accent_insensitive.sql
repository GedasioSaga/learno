-- FUN-037's global search palette needs "revisao" to find "revisão": neither
-- the 'portuguese' text-search dictionary nor pg_trgm strip accents on their
-- own, so title and content are indexed and queried through `unaccent`.
--
-- `unaccent()` itself is STABLE (it depends on search_path to resolve its
-- dictionary), which Postgres refuses inside a generated column or an
-- expression index. Wrapping it as IMMUTABLE is the fix documented in
-- Postgres's own unaccent docs.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Both the dictionary literal AND the `unaccent` call itself must be
-- schema-qualified — qualifying only one is not enough. `immutable_unaccent`
-- is a simple SQL-language function, and Postgres inlines those: at every
-- call site (a functional index, in particular — a GENERATED column on an
-- empty table has no rows to evaluate, so it doesn't surface this), the
-- planner re-substitutes the function's stored body text and re-resolves
-- its unqualified names against the CALLING query's search_path, not
-- against whatever was in scope when this function was created. An
-- unqualified `unaccent(...)` or an unqualified `'unaccent'` dictionary
-- name each independently reproduce the same class of failure
-- ("function unaccent(unknown, text) does not exist", 42883, or "text
-- search dictionary unaccent does not exist") depending on which name
-- fails to resolve. Qualifying both removes the search_path dependency
-- entirely. Verified end-to-end (function creation, the two functional
-- indexes below, and a query that finds "revisão" via "revisao") against a
-- disposable Postgres 18 database on scripts/dev-db.ps1's cluster before
-- landing this.
CREATE FUNCTION immutable_unaccent(text) RETURNS text AS $$
    SELECT public.unaccent(regdictionary 'public.unaccent', $1)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

-- Re-creates 0004's generated column/trigram index through the normalizer
-- above. A generated column's expression can't be altered in place, so this
-- drops and re-adds the column rather than trying to ALTER its definition.
DROP INDEX idx_pages_search_vector;
DROP INDEX idx_pages_title_trgm;
ALTER TABLE pages DROP COLUMN search_vector;
ALTER TABLE pages ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('portuguese', immutable_unaccent(coalesce(title, '')))) STORED;
CREATE INDEX idx_pages_search_vector ON pages USING GIN (search_vector);
CREATE INDEX idx_pages_title_trgm ON pages USING GIN (immutable_unaccent(title) gin_trgm_ops);

-- Same fix for 0006's block content index, so a search for "revisao" also
-- finds a block whose text says "revisão".
DROP INDEX idx_blocks_search_vector;
ALTER TABLE blocks DROP COLUMN search_vector;
ALTER TABLE blocks ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('portuguese', immutable_unaccent(coalesce(plain_text, '')))) STORED;
CREATE INDEX idx_blocks_search_vector ON blocks USING GIN (search_vector);
