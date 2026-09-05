-- One row per answered review — the source of truth SRS-120 (Future Due),
-- SRS-123 (True Retention), and FSRS's own parameter optimizer (SRS-093) all
-- read from, and never overwritten once written.
CREATE TABLE review_log (
    id TEXT PRIMARY KEY NOT NULL,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    reviewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- 1=Again 2=Hard 3=Good 4=Easy — Anki's own convention, reused so the
    -- .apkg importer never has to translate ratings to a fifth vocabulary.
    rating INTEGER NOT NULL,
    state_before TEXT NOT NULL,
    state_after TEXT NOT NULL,
    interval_before INTEGER NOT NULL,
    interval_after INTEGER NOT NULL,
    ease_factor_before INTEGER,
    ease_factor_after INTEGER,
    fsrs_stability_before REAL,
    fsrs_stability_after REAL,
    fsrs_difficulty_before REAL,
    fsrs_difficulty_after REAL,
    duration_ms INTEGER,
    scheduler TEXT NOT NULL,
    CHECK (rating BETWEEN 1 AND 4),
    CHECK (scheduler IN ('sm2', 'fsrs'))
) STRICT;

CREATE INDEX idx_review_log_card_id ON review_log (card_id, reviewed_at);
-- True Retention and Future Due aggregate across all reviews by date range,
-- independent of any one card.
CREATE INDEX idx_review_log_reviewed_at ON review_log (reviewed_at);
