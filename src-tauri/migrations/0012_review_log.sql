-- One row per answered review — the source of truth SRS-120 (Future Due),
-- SRS-123 (True Retention), and FSRS's own parameter optimizer (SRS-093) all
-- read from, and never overwritten once written.
CREATE TABLE review_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 1=Again 2=Hard 3=Good 4=Easy — Anki's own convention, reused so the
    -- .apkg importer never has to translate ratings to a fifth vocabulary.
    rating SMALLINT NOT NULL,
    state_before TEXT NOT NULL,
    state_after TEXT NOT NULL,
    interval_before INTEGER NOT NULL,
    interval_after INTEGER NOT NULL,
    ease_factor_before INTEGER,
    ease_factor_after INTEGER,
    fsrs_stability_before DOUBLE PRECISION,
    fsrs_stability_after DOUBLE PRECISION,
    fsrs_difficulty_before DOUBLE PRECISION,
    fsrs_difficulty_after DOUBLE PRECISION,
    duration_ms INTEGER,
    scheduler TEXT NOT NULL,
    CHECK (rating BETWEEN 1 AND 4),
    CHECK (scheduler IN ('sm2', 'fsrs'))
);

CREATE INDEX idx_review_log_card_id ON review_log (card_id, reviewed_at);
-- True Retention and Future Due aggregate across all reviews by date range,
-- independent of any one card.
CREATE INDEX idx_review_log_reviewed_at ON review_log (reviewed_at);
