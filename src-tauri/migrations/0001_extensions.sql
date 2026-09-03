-- pg_trgm powers fuzzy/substring title matching for the global search palette
-- (FUN-037) and every "pick a page/database" picker; enabling it once here
-- means later migrations can add trigram indexes without repeating this.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
