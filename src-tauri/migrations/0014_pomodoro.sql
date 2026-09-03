-- Fase 5 Pomodoro: one row per timer cycle actually run. Duration/auto-start
-- settings (POM-002/006) are user preferences, not study data, and belong to
-- app config rather than this table.
CREATE TABLE pomodoro_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 'focus' | 'short_break' | 'long_break'
    kind TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (kind IN ('focus', 'short_break', 'long_break'))
);

-- POM-010's daily counter is always "how many focus sessions completed since
-- local midnight" — a partial index on the predicate it always filters by.
CREATE INDEX idx_pomodoro_sessions_started_at ON pomodoro_sessions (started_at) WHERE completed;
