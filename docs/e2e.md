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
   learno.exe (o app de verdade, com SQLite local por trás)
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
que carrega `devUrl` (`http://localhost:1430`) — porque `cfg(dev)` só vira
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
npm run test:e2e
```

Isso builda o Rust (`cargo build` dentro de `src-tauri`), sobe o servidor de
dev do Vite, e roda cada arquivo em `e2e/specs/*.e2e.mjs` numa sessão
própria (um `learno.exe` novo por arquivo). Para iterar num teste só sem
esperar o build do Rust de novo:

```powershell
$env:E2E_SKIP_BUILD = "1"
npx wdio run ./e2e/wdio.conf.mjs --spec ./e2e/specs/primeira-execucao.e2e.mjs
```

Uma janela real do Learno vai abrir e fechar sozinha — isso é o esperado.

### Status de execução

**Verde: 8 specs, 25 testes, 0 falhas**, medido em 05/09/2026 contra o app Tauri
de verdade, e repetido quatro vezes seguidas para não confundir sorte com
estabilidade.

A primeira execução pós-migração encontrou quatro coisas que nenhum teste de
unidade pegaria, e vale registrar o que foram porque três delas eram do produto,
não da suíte:

1. `React.StrictMode` monta o efeito de `App.tsx` duas vezes em desenvolvimento,
   então o app abria o banco DUAS vezes em paralelo e as duas rodavam a migração.
   O sintoma na tela era `table mindmaps already exists` ou `database is locked`,
   e na suíte era sempre "a barra lateral não apareceu em 30s", em spec diferente
   a cada rodada. Corrigido serializando a abertura no backend
   (`AppState::lock_workspace_open`).
2. A própria suíte apagava o banco do usuário: ela limpa `%APPDATA%\com.learno.app`
   entre sessões, que antes só tinha configuração e agora tem o banco. Passou a
   apontar o app para uma pasta de trabalho temporária, uma por spec.
3. Matar o `tauri-driver` não mata o `learno.exe` que ele spawnou, e o Edge
   WebDriver da sessão seguinte às vezes se ligava ao WebView2 da instância
   órfã. `afterSession` agora encerra o app também.
4. Um arrasto de bloco falhava 1 rodada em 4 porque `element.dragAndDrop` solta o
   botão no mesmo instante do movimento final; virou uma sequência explícita de
   ponteiro com pausa antes de soltar.

Quando um teste falha, o `afterTest`/`afterHook` do `wdio.conf.mjs` imprime o que
estava na tela (URL, texto do corpo e o `role="alert"` da tela de erro do app) —
foi esse dump que transformou "o seletor não apareceu" nas causas acima.

### O que a suíte não destrói

- **Configuração pessoal do app** (`%APPDATA%\com.learno.app`): cada sessão
  de teste começa com a pasta de dados do app vazia — `wdio.conf.mjs` apaga
  essa pasta antes de cada spec. Se já havia uma configuração real (app
  aberto manualmente antes), faz backup e restaura depois. Um developer que
  tenha usado o app de verdade não perde seus dados ou preferências rodando
  a suíte — a máquina volta exatamente ao estado de antes.
  
  Por isso a primeira execução do app numa sessão de teste cria um banco
  SQLite novo naquela pasta (PLT-016 valida que isso acontece sem pedir
  nada ao usuário), e as migrações rodam naquele arquivo descartável. Quando
  a sessão termina e a pasta é apagada, tudo desaparece com ela.

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

## Testes principais

### `primeira-execucao.e2e.mjs` — PLT-016

*"Primeira execução numa máquina limpa"* — Substitui o antigo
`first-run-wizard.e2e.mjs`. Após a migração para SQLite, não há mais
assistente de conexão: o banco é um arquivo local criado automaticamente.
O critério de aceite mudou: a primeira execução **não deve pedir nada** ao
usuário.

Valida que:
- O app abre direto no workspace de páginas, sem nenhuma tela de
  configuração.
- O arquivo do banco é criado na pasta de dados do app (`%APPDATA%\com.learno.app\learno.sqlite`)
  antes de qualquer interação do usuário.
- As migrações rodam sozinhas e o schema completo (páginas, blocos,
  histórico de migração) fica pronto ao abrir o app.

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
confirma `aria-level` subindo de 1 para 2. Terceira asserção consulta o banco
do app (via `e2e/lib/db.mjs`) e confirma que `parent_id` da origem é de fato o
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

## Por que a porta de desenvolvimento é 1430, e não 1420

1420 é o padrão do Tauri, e é justamente por isso que ele não serve aqui: outro projeto
desta máquina (`C:\dev\Projeto Genesis\ui`) também é Tauri e já ocupa a 1420 com
`strictPort`. Com os dois no padrão, subir um derrubava o `npm run dev` do outro.

O sintoma, quando isso aconteceu, foi muito pior que um erro de porta ocupada: o
`learno.exe` de desenvolvimento **abriu renderizando o WebView2 do OUTRO app**. Ele só pede
a URL do `devUrl` e não tem como saber quem respondeu. A suíte e2e falhou com um
diagnóstico que não parecia ter nada a ver com o Learno — a tela capturada era o painel do
outro projeto.

O número aparece em **três** lugares, que precisam concordar:

| Arquivo | Campo |
|---|---|
| `vite.config.ts` | `server.port` (e `hmr.port`, 1431) |
| `src-tauri/tauri.conf.json` | `devUrl` — o Tauri **assa** isso no binário de dev |
| `e2e/wdio.conf.mjs` | `DEV_SERVER_URL` |

Mudar um sem os outros faz o app abrir numa tela em branco, sem erro. E como o `devUrl` é
assado no binário, mudar `tauri.conf.json` exige **rebuild** do Rust para valer.
