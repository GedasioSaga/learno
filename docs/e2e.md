# Testes e2e

`docs/CHECKLIST.md` declara `e2e-playwright` como tipo de teste em 183 dos
563 itens. O Playwright não serve para isto: o Learno é um app Tauri v2, não
uma página web, e o Playwright não dirige o WebView2 (o motor do Edge que o
Tauri usa no Windows) diretamente. Este documento descreve o runner que
substitui esse rótulo — o mesmo que a própria documentação do Tauri v2
recomenda para Windows — e como rodá-lo.

## O runner: `tauri-driver` + Microsoft Edge WebDriver + WebdriverIO

```
WebdriverIO (Node, e2e/specs/*.e2e.mjs)
        │  protocolo WebDriver, localhost:4444
        ▼
   tauri-driver (crate Rust oficial do Tauri)
        │  spawna o binário do app; repassa comandos WebDriver
        ▼
Microsoft Edge WebDriver (msedgedriver.exe)
        │  dirige o WebView2 (Chromium) da janela do learno.exe
        ▼
   learno.exe (o app de verdade, com Postgres de verdade por trás)
```

Não existe "modo headless" aqui: uma janela real do Learno abre na tela
durante a suíte. Isto é esperado — é a mesma coisa que `npm run tauri dev`
faz, só que dirigida por um WebDriver em vez de por um humano.

**Por que não a alternativa "embedded" do `@wdio/tauri-service`:** a
documentação atual do Tauri (v2) também descreve um driver embutido no
próprio processo do app, via um plugin Rust (`tauri-plugin-wdio-webdriver`)
que precisaria ser adicionado a `src-tauri/Cargo.toml`/`src-tauri/src/lib.rs`.
Como esta tarefa foi explicitamente delimitada para não tocar em
`src-tauri/src/`, essa opção ficou fora — o caminho por `tauri-driver`
(externo, sem tocar no app) é o único que cabe nesse limite, e é também o
caminho "clássico", mais maduro, documentado desde o Tauri v1.

## Por que o app sobe contra o servidor de dev do Vite

`src-tauri/Cargo.toml` não declara o bloco padrão do template do Tauri:

```toml
[features]
custom-protocol = ["tauri/custom-protocol"]
```

Sem essa feature ligada na crate `tauri`, `tauri::Builder::get_app_url`
(`tauri-2.11.5/src/manager/mod.rs`) sempre resolve pelo ramo `#[cfg(dev)]` —
que carrega `devUrl` (`http://localhost:1420`) — porque `cfg(dev)` só vira
`false` quando essa feature está ligada (`tauri-2.11.5/build.rs:255-261`).
Isso vale para **qualquer** build Rust deste crate hoje, `cargo build`,
`tauri build` ou `tauri build --debug`, com ou sem `--release`: nenhum deles
jamais carrega o frontend embutido (`frontendDist`) enquanto esse bloco não
existir.

Na prática isso não afeta ninguém rodando `npm run tauri dev` — é
exatamente o que ele já faz. Só quebraria um build de **produção** de
verdade (a promessa de instalador da Fase 6, fora do escopo desta tarefa).
Por isso `e2e/wdio.conf.mjs` sobe o app contra um `npm run dev` (Vite) de
verdade, do mesmo jeito que `tauri dev` já faz — nenhuma mudança em
`src-tauri/Cargo.toml` foi necessária ou foi feita.

## Como rodar

```powershell
$env:DATABASE_URL = "postgres://learno@127.0.0.1:5433/learno_dev"
$env:LEARNO_TEST_DATABASE_URL = "postgres://learno@127.0.0.1:5433/learno_test"
npm run test:e2e
```

Isso builda o Rust (`cargo build` dentro de `src-tauri`), sobe o servidor de
dev do Vite, e roda cada arquivo em `e2e/specs/*.e2e.mjs` numa sessão
própria (um `learno.exe` novo por arquivo). Para iterar num teste só sem
esperar o build do Rust de novo:

```powershell
$env:E2E_SKIP_BUILD = "1"
npx wdio run ./e2e/wdio.conf.mjs --spec ./e2e/specs/first-run-wizard.e2e.mjs
```

Uma janela real do Learno vai abrir e fechar sozinha — isso é o esperado.

### O que a suíte não destrói

- **`config.json` de um dev de verdade** (`%APPDATA%\com.learno.app\config.json`):
  cada sessão precisa nascer sem configuração salva (é o que faz o
  assistente de primeira execução aparecer), então `wdio.conf.mjs` apaga
  esse arquivo antes de cada sessão. Se já havia um `config.json` real, faz
  backup antes e restaura depois — um developer com o app já configurado
  não perde a configuração rodando a suíte. Se não havia nenhum (máquina
  nunca aberta manualmente), o arquivo que a própria sessão de teste cria
  ao conectar de verdade (necessário para chegar à árvore de páginas — ver
  `page-tree-drag-and-drop.e2e.mjs`) é apagado de novo ao fim, para a
  máquina voltar exatamente ao estado de antes.
- **`learno_dev`**: o teste do assistente de primeira execução conecta nele
  de propósito (é o cenário real de "banco vazio, primeira vez"), e as
  migrações que ele aplica ficam — não há rollback. Isso é o comportamento
  esperado do próprio PLT-016/PLT-002, não um efeito colateral do teste.
- **`learno_test`**: o teste de drag-and-drop cria duas páginas com título
  carimbado por timestamp e as apaga no `after()` — best-effort, não trava
  o resultado do teste se a limpeza falhar.

## Dependências instaladas para isto

Devidamente pré-checadas contra a regra 12 (última atualização, popularidade,
CVE aberta) antes de instalar:

- **`tauri-driver`** (crate Rust, `cargo install tauri-driver --locked`) —
  mantido pelo próprio time do Tauri, é o runner oficial.
- **Microsoft Edge WebDriver** (`e2e/.bin/msedgedriver.exe`, não versionado —
  ver "Reproduzindo numa máquina nova" abaixo) — precisa bater
  **exatamente** com a versão do Edge instalado.
- **`@wdio/cli`, `@wdio/local-runner`, `@wdio/mocha-framework`,
  `@wdio/spec-reporter`, `webdriverio`** (devDependencies do `package.json`
  raiz, todas na mesma faixa de versão, `9.31.x`) — o cliente WebDriver.
  `npm audit` acusou 15 vulnerabilidades (1 moderada, 14 altas) nessas
  devDependencies de teste, todas em dependências transitivas de
  ferramental (`deepmerge-ts`, `extract-zip` via `@puppeteer/browsers`,
  `serialize-javascript` via `mocha`) — nenhuma delas processa dado hostil
  neste projeto (não baixamos zips nem desserializamos entrada externa por
  aqui) e corrigi-las de verdade (`npm audit fix --force`) rebaixaria o
  `@wdio/cli` para uma versão alpha antiga, uma troca pior que o problema.
  Ficou registrado aqui para quem revisar dependências depois.

### Reproduzindo numa máquina nova

`e2e/.bin/` está no `.gitignore` (o `.exe` do driver é ~22MB e específico da
versão do Edge instalado, não faz sentido versionar). Para gerar de novo:

```powershell
$edgeVersion = (Get-Item "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe").VersionInfo.ProductVersion
Invoke-WebRequest "https://msedgedriver.microsoft.com/$edgeVersion/edgedriver_win64.zip" -OutFile edgedriver.zip
Expand-Archive edgedriver.zip -DestinationPath e2e/.bin -Force
```

(O host antigo, `msedgedriver.azureedge.net`, documentado em vários lugares
como o endereço oficial, não resolve mais nesta rede — `msedgedriver.microsoft.com`
é quem responde hoje, mesmo caminho de versão.)

## Os dois testes

### `first-run-wizard.e2e.mjs` — PLT-016

*"Assistente de primeira execução para conectar ao Postgres local"* — o
critério de aceite (`docs/CHECKLIST.md`) só se prova com o processo Tauri de
verdade, IPC real e um Postgres de verdade respondendo; um teste de
componente Vitest troca `invoke()` por mock e nunca passa perto disso.

Sobe o app contra `learno_dev` **vazio** (sem `_sqlx_migrations` nem
nenhuma das 17 tabelas — confirmado por `psql` antes da rodada), preenche o
formulário, clica "Testar conexão", clica "Continuar", e confirma que a
árvore de páginas aparece. Depois da rodada, `psql` contra `learno_dev`
mostra as 17 tabelas — prova, fora do DOM, que a migração (PLT-002) rodou
de verdade.

**Achado que este teste expôs, ainda de pé:** o campo Senha em
`FirstRunWizard.tsx` nasce com o `required` padrão de `Field` (nada ali o
desliga). Contra um Postgres local com autenticação `trust` — como o
cluster de dev desta própria tarefa — o conteúdo da senha é irrelevante,
mas o campo **vazio** aciona a validação nativa do HTML5 e barra o clique
em "Testar conexão" antes mesmo do `onSubmit` disparar: nenhum alerta,
nenhuma mudança de estado, só o clique sendo engolido pelo navegador. Um
usuário real de Postgres local sem senha não consegue preencher este
assistente deixando a Senha em branco. `first-run-wizard.e2e.mjs` contorna
isto preenchendo um valor qualquer só para conseguir testar o alvo real do
arquivo (a conexão); não foi corrigido porque `FirstRunWizard.tsx` está em
`src/`, fora do escopo permitido para esta tarefa.

### `page-tree-drag-and-drop.e2e.mjs` — FUN-005

*"Drag-and-drop para aninhar página"* — `PageTree.tsx` decide se o solto
vira "antes"/"depois"/"aninhar" a partir de `event.clientY` contra
`getBoundingClientRect()` do alvo (`zoneFromPointerY`). Em jsdom (Vitest)
todo elemento tem rect zerado — não existe layout de verdade —, então essa
lógica geométrica nunca é exercitada por um teste de componente; só um
WebView real, com layout real, prova este critério de aceite.

Cria duas páginas raiz com título carimbado por timestamp, arrasta uma para
o meio da outra (`dragAndDrop` mira o centro do elemento, que cai na faixa
"aninhar" de `zoneFromPointerY`), expande o pai (a recém-aninhada só
reaparece na árvore depois disso — `move()` na store não expande sozinho) e
confirma `aria-level` subindo de 1 para 2. Terceira asserção roda `psql`
direto no `learno_test` e confirma que `parent_id` da origem é de fato o
`id` do destino — não só o DOM, o dado persistido.

## Nota sobre desenvolvimento concorrente

Durante a investigação para escrever o teste de PLT-016, a leitura de
`src/lib/ipc.ts` e `src/components/FirstRunWizard.tsx` mostrou, num primeiro
momento, um defeito real: `handleContinue` chamava `saveAppConfig()`, que
invocava um comando Tauri (`save_app_config`) nunca registrado em
`tauri::generate_handler!` — o clique em "Continuar" teria sempre falhado.
Antes da suíte rodar de ponta a ponta, esses arquivos foram alterados (fora
desta sessão) para a versão atual, com `connectDatabase()`/`connect_database`
e o modo `reconnect`, e o defeito deixou de existir. Os testes finais deste
relatório foram verificados contra o código já corrigido — nada aqui
depende do estado antigo. Fica registrado porque mostra exatamente o tipo
de lacuna que motivou esta tarefa (um caminho que só um teste de ponta a
ponta alcança) e porque, num repositório com mais de uma sessão trabalhando
ao mesmo tempo, os arquivos podem mudar debaixo do pé de quem investiga.
