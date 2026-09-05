// Falar com o Postgres de dentro de uma spec, sem passar SQL pela linha de
// comando.
//
// O jeito óbvio — `execFileSync("psql", [url, "-tAc", sql])` — quebra em
// silêncio neste projeto no primeiro título acentuado. No Windows, o
// argumento vai para o processo filho codificado na página de código ANSI da
// máquina, não em UTF-8, e o servidor rejeita os bytes:
//
//     ERROR:  invalid byte sequence for encoding "UTF8": 0xe1 0x72 0x69
//
// (0xe1 é "á" em latin-1.) O erro sai no stderr do psql, e uma spec que só lê
// o stdout enxerga string vazia em vez de falha — isto é, a asserção falha
// dizendo a coisa errada, e quem lê acha que o app não gravou. Foi assim que
// `page-link.e2e.mjs` falhou na primeira execução da suíte.
//
// A correção é mandar o SQL por stdin como Buffer UTF-8 e dizer ao psql que é
// isso que está chegando (`PGCLIENTENCODING`). Aí o único caminho de bytes é
// o buffer que nós mesmos codificamos.
import { execFileSync } from "node:child_process";

import { TEST_DB } from "./env.mjs";

/** `postgresql://user@host:porta/banco` do alvo, sem senha (o cluster de teste usa autenticação trust — ver `scripts/dev-db.ps1`). */
function urlOf(target) {
  return `postgresql://${target.user}@${target.host}:${target.port}/${target.database}`;
}

/**
 * Roda `sql` e devolve o stdout cru, já sem espaço nas pontas.
 *
 * `-tA` (tuplas apenas, não alinhado) para a saída ser exatamente o valor,
 * sem cabeçalho nem moldura — o que uma asserção quer comparar. `-v
 * ON_ERROR_STOP=1` para um erro de SQL virar exit code diferente de zero, e
 * portanto exceção aqui, em vez de stdout vazio que a spec interpretaria
 * como "o app não gravou".
 *
 * @param {string} sql
 * @param {{ target?: import("./env.mjs").PgTarget }} [options]
 * @returns {string}
 */
export function psql(sql, options = {}) {
  const target = options.target ?? TEST_DB;
  return execFileSync("psql", [urlOf(target), "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: Buffer.from(sql, "utf-8"),
    encoding: "utf-8",
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
  }).trim();
}

/**
 * Roda `sql` e devolve uma linha de saída por tupla, sem linha vazia.
 *
 * Existe porque `psql` no Windows escreve `\r\n` entre as tuplas, não `\n`:
 * o jeito óbvio de partir a saída de uma consulta multi-linha —
 * `out.trim().split("\n")` — devolve `["A\r", "C\r", "B"]` em vez de
 * `["A", "C", "B"]`, e a comparação falha em TODAS as linhas menos a última.
 * O `.trim()` esconde o problema em consulta de valor único (só existe um
 * `\r`, e é o último), que é justamente por que ele passou batido: os specs
 * que só leem um valor sempre funcionaram. Foi assim que `drag-blocks`
 * reprovou EDT-050/EDT-051 enquanto o arrasto funcionava — DOM e Postgres
 * já estavam em `A, C, B`.
 *
 * @param {string} sql
 * @param {{ target?: import("./env.mjs").PgTarget }} [options]
 * @returns {string[]}
 */
export function psqlRows(sql, options = {}) {
  return psql(sql, options)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Como `psql`, mas para SQL cujo resultado não interessa (limpeza no
 * `after`). Nunca lança: limpeza best-effort não deve derrubar o resultado
 * do teste em si.
 *
 * @param {string} sql
 * @param {{ target?: import("./env.mjs").PgTarget }} [options]
 */
export function psqlQuiet(sql, options = {}) {
  try {
    psql(sql, options);
  } catch {
    // Deliberado: ver o comentário acima.
  }
}

/**
 * Escapa uma string para caber entre apóstrofos num literal SQL.
 *
 * Existe porque as specs montam SQL por interpolação de título de página, e
 * um título com apóstrofo (`"O que é 'cloze'"`) fecharia o literal cedo. Não
 * é defesa contra entrada hostil — é código de teste falando com o banco de
 * teste — mas um teste que quebra por causa de pontuação no dado é um teste
 * que mente sobre o app.
 *
 * @param {string} value
 * @returns {string}
 */
export function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
