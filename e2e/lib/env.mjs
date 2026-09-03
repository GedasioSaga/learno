// Só parsing puro de connection string — sem I/O, para poder ser testado e
// reusado tanto pelo wdio.conf quanto pelas specs sem duplicar a lógica.

/** @typedef {{ host: string, port: number, database: string, user: string, password: string }} PgTarget */

/**
 * Quebra uma `postgres://user@host:port/db` nos campos que o assistente de
 * primeira execução (e o comando `connect_database` por baixo dele) espera —
 * mesma forma de `ConnectionTestInput` em `src-tauri/src/config/mod.rs`.
 * @param {string} raw
 * @returns {PgTarget}
 */
export function parsePgUrl(raw) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password || ""),
  };
}

/**
 * Banco de desenvolvimento local (`DATABASE_URL`) — o mesmo que o resto do
 * projeto usa via `scripts/dev-db.ps1`. Cai no valor documentado na tarefa
 * quando a variável não está exportada, para a suíte não travar por
 * esquecimento em vez de falhar explicando o motivo.
 */
export const DEV_DB = parsePgUrl(
  process.env.DATABASE_URL ?? "postgres://learno@127.0.0.1:5433/learno_dev",
);

/** Banco descartável de teste (`LEARNO_TEST_DATABASE_URL`) — mesmo fallback acima. */
export const TEST_DB = parsePgUrl(
  process.env.LEARNO_TEST_DATABASE_URL ?? "postgres://learno@127.0.0.1:5433/learno_test",
);
