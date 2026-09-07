// Configuração do WebdriverIO para os testes e2e do Learno.
//
// Tauri v2 não é uma página web comum e o Playwright não dirige o WebView2
// diretamente — o caminho que a própria documentação do Tauri recomenda (e o
// único comprovado nesta máquina, ver docs/e2e.md) é: `tauri-driver` (crate
// Rust oficial) na frente do Microsoft Edge WebDriver, falado por um cliente
// WebDriver comum — aqui, WebdriverIO. `tauri-driver` spawna o binário do
// app e faz a ponte de protocolo; o Edge WebDriver dirige o WebView2 (que é
// Chromium) por baixo.
//
// Por que o app sobe contra o servidor de dev do Vite (`devUrl`) em vez de
// rodar com o frontend embutido, mesmo aqui em e2e: `src-tauri/Cargo.toml`
// não declara `[features] custom-protocol = ["tauri/custom-protocol"]` — o
// bloco padrão do template do Tauri que faz `tauri build` compilar contra
// `frontendDist`. Sem ele, `tauri::get_app_url` (ver
// `tauri-2.11.5/src/manager/mod.rs`) resolve por `#[cfg(dev)]`, que só é
// `false` quando essa feature está ligada — nunca acontece neste projeto, com
// ou sem `--debug`/`--release`. Na prática isso não afeta ninguém rodando
// `npm run tauri dev` (é exatamente o que ele já faz), só quebraria um build
// de produção de verdade — fora do escopo desta tarefa (não mexer em
// `src-tauri/Cargo.toml`) e documentado em `docs/e2e.md`.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const APP_BINARY = path.resolve(repoRoot, "src-tauri", "target", "debug", "learno.exe");
const NATIVE_DRIVER = path.resolve(__dirname, ".bin", "msedgedriver.exe");
const TAURI_DRIVER_BIN = path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver.exe");
const DEV_SERVER_URL = "http://localhost:1430";

// A pasta de dados do app — o mesmo caminho que
// `AppHandle::path().app_data_dir()` resolve no Windows para o identifier
// "com.learno.app" declarado em `src-tauri/tauri.conf.json`. Dentro dela vive
// o `config.json` do `tauri-plugin-store`.
const APP_DATA_DIR = path.join(process.env.APPDATA ?? "", "com.learno.app");
const APP_CONFIG_FILE = path.join(APP_DATA_DIR, "config.json");

// A pasta de trabalho que a suíte usa — um diretório temporário só dela, e a
// razão de ele existir está no comentário de `E2E_DATA_DIR` em
// `e2e/lib/db.mjs`: sem isso, apagar a pasta de dados entre sessões apagaria
// o banco de verdade de quem roda a suíte na própria máquina de trabalho.
//
// UMA POR SPEC, e isso não é zelo: cada spec sobe seu próprio `learno.exe`, e
// o encerramento de um não é síncrono com a subida do próximo. Com uma pasta
// só, o `beforeSession` da spec seguinte tentava apagar o arquivo do banco
// enquanto o app anterior ainda o segurava — no Windows um arquivo aberto não
// é removido —, e o app novo então subia contra um banco travado e nunca
// chegava a mostrar a barra lateral. Foi exatamente assim que
// `synced-blocks.e2e.mjs` falhou com "element ([aria-label='Páginas']) still
// not displayed after 30000ms" na primeira execução da suíte pós-migração,
// enquanto passava sozinho em 4,7s.
//
// O caminho é derivado do nome do arquivo da spec e publicado em
// `LEARNO_E2E_DATA_DIR`, que `e2e/lib/db.mjs` lê: `beforeSession` roda dentro
// do processo do worker, antes de a spec ser importada, então a variável está
// no lugar quando o módulo é carregado.
function dataDirForSpec(specPath) {
  const nome = path.basename(specPath ?? "sessao").replace(/\.e2e\.mjs$/, "");
  return path.join(os.tmpdir(), `learno-e2e-workspace-${nome}`);
}

let tauriDriverProcess;
let viteProcess;
let exiting = false;
/** Caminho do backup de um `config.json` real de dev, se algum existir — restaurado em `afterSession`. */
let configBackupPath = null;

/** Espera o servidor do Vite responder — pode levar alguns segundos para o dev server subir. */
function waitForDevServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`Vite não respondeu em ${url} depois de ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

/** `true` só depois que `backupAndWipeAppData` já rodou uma vez, para `restoreDevConfig` saber se "sem backup" significa "não tinha nada" ou "ainda não configurado". */
let hadRealConfig = false;

/**
 * Cada sessão precisa nascer com a pasta de dados vazia. Antes isso servia
 * para o assistente de primeira execução reaparecer; depois da migração para
 * SQLite serve para algo mais forte — apagar a pasta apaga o BANCO, então
 * cada rodada da suíte começa com um banco novo, migrado do zero, sem nada
 * que uma rodada anterior tenha deixado. É o equivalente ao banco descartável
 * que a versão Postgres criava no cluster.
 *
 * Isto NÃO apaga os dados de um dev de verdade sem devolvê-los depois: faz
 * backup do `config.json` antes de apagar, e `restoreDevConfig` (em
 * `afterSession`) devolve exatamente o que havia antes — o arquivo original
 * se existia, ou nenhum arquivo se a máquina nunca tinha rodado o app.
 */
function backupAndWipeAppData(dataDir) {
  hadRealConfig = fs.existsSync(APP_CONFIG_FILE);
  if (hadRealConfig) {
    configBackupPath = path.join(os.tmpdir(), `learno-e2e-config-backup-${Date.now()}.json`);
    fs.copyFileSync(APP_CONFIG_FILE, configBackupPath);
  }
  fs.rmSync(APP_DATA_DIR, { recursive: true, force: true });

  // A pasta de trabalho desta spec nasce vazia — é ela que guarda o banco, e
  // é o equivalente ao banco descartável que a versão Postgres criava no
  // cluster.
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  // E o app é apontado para lá ANTES de subir, escrevendo o mesmo
  // `config.json` que `tauri-plugin-store` leria — a chave é
  // `config::DATA_DIR_STORE_KEY` em `src-tauri/src/config/mod.rs`. Sem isto o
  // app criaria o banco em `APP_DATA_DIR`, e o wipe da próxima sessão o
  // apagaria junto com os dados reais de quem estiver na mesma máquina.
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify({ app_data_dir: dataDir }), "utf-8");
}

function restoreDevConfig() {
  if (hadRealConfig) {
    fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    fs.copyFileSync(configBackupPath, APP_CONFIG_FILE);
    fs.rmSync(configBackupPath, { force: true });
    configBackupPath = null;
  } else {
    // Não tinha `config.json` nenhum antes desta sessão — não é para sobrar
    // um agora só porque o teste precisou conectar de verdade para chegar
    // ao estado "pronto" (ver o comentário de `page-tree-drag-and-drop.e2e.mjs`).
    fs.rmSync(APP_DATA_DIR, { recursive: true, force: true });
  }
}

function stopTauriDriver() {
  exiting = true;
  tauriDriverProcess?.kill();
}

/**
 * Mata qualquer `learno.exe` que tenha sobrado da sessão anterior.
 *
 * Matar o `tauri-driver` NÃO mata o app que ele spawnou: o processo fica
 * órfão, com a janela e o WebView2 de pé. Quando a sessão seguinte sobe, o
 * Edge WebDriver tem mais de um WebView2 do mesmo executável para escolher, e
 * às vezes se liga ao errado — o da sessão morta, que nunca vai mostrar a
 * barra lateral. O sintoma é sempre o mesmo e sempre em spec diferente:
 * "element ([aria-label='Páginas']) still not displayed after 30000ms" num
 * `before all`, enquanto a mesma spec passa sozinha em segundos.
 *
 * Restrito ao Windows porque é onde a suíte roda (WebView2), e best-effort de
 * propósito: não ter nada para matar é o caso normal, não um erro.
 */
function stopAppProcesses() {
  if (process.platform !== "win32") return;
  spawnSync("taskkill", ["/IM", "learno.exe", "/F", "/T"], { stdio: "ignore" });
}

/**
 * `spawn("npm", …, { shell: true })` no Windows cria um `cmd.exe` cujo PID é
 * o único que `viteProcess.kill()` conhece — o Vite de verdade nasce como
 * neto desse `cmd.exe`, e matar só o pai deixa o Vite (e a porta 1430) para
 * trás. `taskkill /T` mata a árvore inteira; fica restrito ao Windows de
 * propósito, e a falha é ignorada porque este é só um `onComplete` de
 * limpeza — nunca deve derrubar o resultado da suíte.
 */
function stopViteServer() {
  if (!viteProcess?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(viteProcess.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    viteProcess.kill();
  }
}

function onShutdown(fn) {
  const cleanup = () => {
    try {
      fn();
    } finally {
      process.exit();
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
  process.on("SIGBREAK", cleanup);
}
onShutdown(() => {
  stopTauriDriver();
  stopAppProcesses();
  stopViteServer();
});

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.mjs"],
  maxInstances: 1,
  capabilities: [
    {
      "wdio:maxInstances": 1,
      "tauri:options": { application: APP_BINARY },
    },
  ],
  logLevel: "warn",
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 90000 },

  // Garante que o binário Rust reflete o código atual (compila em
  // `src-tauri` direto, sem passar por `tauri build`: o motivo de rodar
  // contra o servidor de dev, não um bundle, está no comentário do topo
  // deste arquivo) e sobe o servidor do Vite que esse binário espera
  // encontrar em `http://localhost:1430` — o mesmo servidor que `npm run
  // tauri dev` sobe, só que aqui sem o wrapper do Tauri CLI em volta. Pule
  // o build com `E2E_SKIP_BUILD=1` quando já tiver acabado de compilar na
  // mão (ex.: iterando num teste só).
  onPrepare: () => {
    if (!process.env.E2E_SKIP_BUILD) {
      const result = spawnSync("cargo", ["build"], {
        cwd: path.join(repoRoot, "src-tauri"),
        stdio: "inherit",
        shell: true,
      });
      if (result.status !== 0) {
        throw new Error("`cargo build` do learno.exe falhou — ver a saída acima.");
      }
    }

    viteProcess = spawn("npm", ["run", "dev"], {
      cwd: repoRoot,
      stdio: [null, process.stdout, process.stderr],
      shell: true,
    });
    return waitForDevServer(DEV_SERVER_URL, 30000);
  },

  onComplete: () => {
    stopViteServer();
  },

  // Um app Tauri por sessão: `tauri-driver` sobe aqui e é quem de fato
  // spawna `learno.exe` na hora em que a sessão WebDriver é criada.
  beforeSession: (_config, _capabilities, specs) => {
    // `LEARNO_E2E_DATA_DIR` precisa estar no ambiente antes de a spec ser
    // importada — `e2e/lib/db.mjs` a lê no momento do import.
    const dataDir = dataDirForSpec(specs?.[0]);
    process.env.LEARNO_E2E_DATA_DIR = dataDir;
    backupAndWipeAppData(dataDir);
    tauriDriverProcess = spawn(TAURI_DRIVER_BIN, ["--native-driver", NATIVE_DRIVER], {
      stdio: [null, process.stdout, process.stderr],
    });
    tauriDriverProcess.on("error", (error) => {
      console.error("tauri-driver error:", error);
      process.exit(1);
    });
    tauriDriverProcess.on("exit", (code) => {
      if (!exiting) {
        console.error("tauri-driver exited with code:", code);
        process.exit(1);
      }
    });
  },

  // Diagnóstico de falha: quando um teste cai, o que estava na tela é a
  // primeira pergunta, e sem isto a única pista é "o seletor não apareceu".
  // O app tem uma tela de erro própria (`role="alert"` em `App.tsx`) para
  // quando o banco não abre — se ela estiver lá, este dump a mostra em vez de
  // deixar a falha parecer um problema de seletor.
  afterHook: async (_test, _context, { passed }) => {
    if (passed) return;
    await dumpScreen();
  },

  afterTest: async (_test, _context, { passed }) => {
    if (passed) return;
    await dumpScreen();
  },

  // `afterSession` pode não rodar se a sessão nunca chegou a abrir — por
  // isso `onShutdown` acima também chama `stopTauriDriver` no encerramento
  // do processo do runner, como rede de segurança.
  afterSession: () => {
    stopTauriDriver();
    stopAppProcesses();
    restoreDevConfig();
  },
};

/** Ver o comentário de `afterHook` acima. */
async function dumpScreen() {
  try {
    const texto = await browser.execute(() => ({
      url: window.location.href,
      corpo: document.body?.innerText?.slice(0, 600) ?? "(sem body)",
      alerta: document.querySelector('[role="alert"]')?.textContent ?? null,
    }));
    console.error("[diagnóstico] tela no momento da falha:", JSON.stringify(texto, null, 2));
  } catch (erro) {
    console.error("[diagnóstico] não foi possível ler a tela:", erro?.message ?? erro);
  }
}
