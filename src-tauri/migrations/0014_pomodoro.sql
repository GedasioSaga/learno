-- Fase 5 Pomodoro: one row per timer cycle actually run. Duration/auto-start
-- settings (POM-002/006) are user preferences, not study data, and belong to
-- app config rather than this table.
CREATE TABLE pomodoro_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    -- 'focus' | 'short_break' | 'long_break'
    kind TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT,
    duration_seconds INTEGER NOT NULL,
    -- Booleano em SQLite é INTEGER 0/1 (ver a tabela de equivalências em
    -- `docs/MIGRACAO-SQLITE.md`); o CHECK impede que a ausência de um tipo
    -- BOOLEAN vire uma coluna aceitando qualquer inteiro.
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (kind IN ('focus', 'short_break', 'long_break'))
) STRICT;

-- POM-010's daily counter is always "how many focus sessions completed since
-- local midnight" — a partial index on the predicate it always filters by.
-- `WHERE completed` da versão Postgres vira `WHERE completed = 1`: SQLite não
-- tem tipo booleano, então uma coluna solta num índice parcial não é um
-- predicado válido.
CREATE INDEX idx_pomodoro_sessions_started_at ON pomodoro_sessions (started_at) WHERE completed = 1;
