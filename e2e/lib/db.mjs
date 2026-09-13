// Falar com o banco do app de dentro de uma spec — a metade do e2e que
// confere que o que apareceu na tela realmente virou linha gravada.
//
// Substitui `psql.mjs`, que shellava para o binário `psql` contra um cluster
// PostgreSQL. Depois da migração para SQLite (ver `docs/MIGRACAO-SQLITE.md`)
// não há servidor nem binário externo: o banco do app é um arquivo, e o Node
// 22 abre esse arquivo direto com `node:sqlite`. Some junto o problema mais
// caro daquele arquivo — o SQL ia para o `psql` por argumento de linha de
// comando, codificado na página de código ANSI do Windows, e o primeiro
// título acentuado virava `invalid byte sequence for encoding "UTF8"` no
// stderr enquanto a spec lia um stdout vazio e acusava o app de não ter
// gravado. Aqui não existe processo filho: a string vai como string.
//
// `node:sqlite` é marcado como experimental no Node 22 e imprime um aviso na
// primeira importação. É dependência ZERO (vem no runtime), e é isso que o
// torna preferível a `better-sqlite3` para código de teste.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A pasta de dados do app — o que `AppHandle::path().app_data_dir()` resolve
 * no Windows para o identifier "com.learno.app" de
 * `src-tauri/tauri.conf.json`. É onde vive o `config.json` do
 * `tauri-plugin-store`, e onde o app criaria o banco se ninguém escolhesse
 * outra pasta.
 */
export const APP_DATA_DIR = path.join(process.env.APPDATA ?? "", "com.learno.app");

/**
 * A pasta de trabalho que a suíte e2e usa, e o motivo dela existir.
 *
 * O `wdio.conf.mjs` apaga a pasta de dados do app antes de cada sessão, para
 * que toda rodada comece do zero. Enquanto os dados viviam num PostgreSQL,
 * isso só apagava configuração. Depois da migração para SQLite, o banco
 * também mora lá — e apagar a pasta passaria a apagar **os dados de verdade
 * de quem roda a suíte na própria máquina de trabalho**.
 *
 * Então a suíte não usa a pasta padrão: o `wdio.conf.mjs` grava um
 * `config.json` apontando a pasta de trabalho para cá, um diretório
 * temporário que é só dela. O banco do usuário nunca é criado nem tocado.
 *
 * E é UMA POR SPEC: o `wdio.conf.mjs` deriva o caminho do nome do arquivo da
 * spec e o publica em `LEARNO_E2E_DATA_DIR` antes de a spec ser importada.
 * Com uma pasta só para todas, o `beforeSession` de uma spec tentava apagar o
 * banco enquanto o `learno.exe` da spec anterior ainda o segurava, e o app
 * seguinte nunca chegava a abrir — ver o comentário de `dataDirForSpec` lá.
 * O valor padrão abaixo só existe para uso fora do runner (inspecionar o
 * banco à mão depois de uma rodada, por exemplo).
 */
export const E2E_DATA_DIR =
  process.env.LEARNO_E2E_DATA_DIR ?? path.join(os.tmpdir(), "learno-e2e-workspace");

/** O arquivo do banco dentro dela. O nome é fixo em `config::DATABASE_FILE_NAME`. */
export const DATABASE_FILE = path.join(E2E_DATA_DIR, "learno.sqlite");

/**
 * Abre o banco do app somente para leitura e devolve o handle.
 *
 * Somente leitura por dois motivos: o app está de pé com o arquivo aberto em
 * WAL, e uma spec que grava direto no banco estaria testando o próprio SQL
 * em vez do app. Para semear estado, use a UI (é o que as specs fazem) ou o
 * comando IPC correspondente.
 */
function open() {
  if (!fs.existsSync(DATABASE_FILE)) {
    throw new Error(
      `o banco do app ainda não existe em ${DATABASE_FILE} — o app abriu? (ele é criado na primeira execução)`,
    );
  }
  return new DatabaseSync(DATABASE_FILE, { readOnly: true });
}

/**
 * Roda `sql` e devolve as linhas como array de objetos.
 *
 * @param {string} sql
 * @param {unknown[]} [params] valores para os `?` do SQL — sempre prefira
 *   isto a interpolar no texto: um título com apóstrofo não quebra nada, e
 *   não há literal a escapar.
 * @returns {Record<string, unknown>[]}
 */
export function query(sql, params = []) {
  const db = open();
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/**
 * O primeiro valor da primeira coluna, ou `undefined` se a consulta não
 * devolveu linha nenhuma. É a forma que uma asserção de valor único quer.
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {unknown}
 */
export function scalar(sql, params = []) {
  const [linha] = query(sql, params);
  if (linha === undefined) return undefined;
  return Object.values(linha)[0];
}

/**
 * Uma coluna, várias linhas, como array de strings — a forma que uma
 * asserção de ordem quer (a ordem dos blocos depois de um arrasto, os
 * títulos de uma árvore).
 *
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {string[]}
 */
export function column(sql, params = []) {
  return query(sql, params).map((linha) => String(Object.values(linha)[0]));
}

/**
 * Espera até `sql` devolver o valor esperado, ou estoura o tempo.
 *
 * Existe porque a gravação é assíncrona em relação ao clique: o app responde
 * na tela e persiste logo depois, então ler o banco no instante seguinte à
 * interação dá falso negativo de vez em quando. Esperar por uma condição é
 * mais honesto (e mais rápido no caso comum) que dormir um tempo fixo.
 *
 * `ler` pode ser síncrona (uma consulta ao banco) ou assíncrona (qualquer
 * coisa que passe pelo WebDriver, como ler um atributo do documento) — o
 * resultado é aguardado antes de a condição olhar para ele. Sem esse `await`,
 * uma função assíncrona faria a condição receber a Promise em si, que nunca
 * satisfaz nada e produz o erro mais confuso possível: "não foi satisfeita;
 * último valor lido: {}".
 *
 * @param {() => unknown | Promise<unknown>} ler o que consultar a cada volta
 * @param {(valor: unknown) => boolean} condicao
 * @param {{ timeoutMs?: number, intervalMs?: number, mensagem?: string }} [options]
 */
export async function waitFor(ler, condicao, options = {}) {
  const { timeoutMs = 10000, intervalMs = 100, mensagem = "condição no banco" } = options;
  const limite = Date.now() + timeoutMs;
  let ultimo;

  while (Date.now() < limite) {
    try {
      ultimo = await ler();
      if (condicao(ultimo)) return ultimo;
    } catch (erro) {
      ultimo = erro;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`${mensagem} não foi satisfeita em ${timeoutMs}ms; último valor lido: ${JSON.stringify(ultimo)}`);
}
