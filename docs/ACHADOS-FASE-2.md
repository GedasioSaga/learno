# Achados da Fase 2 — entrada para a Fase 3

Mesmo espírito de `ACHADOS-FASE-1.md`: o que ficou aberto ao fim da Fase 2, apurado
olhando o repositório e o app rodando, não a saída dos testes. Cada item aqui é dívida
conhecida ou defeito encontrado, com âncora — não impressão.

A Fase 2 foi construída por 21 peças paralelas em pastas disjuntas, seguidas de uma
rodada de 7 correções que exigiam o núcleo, o Rust ou duas pastas ao mesmo tempo, e
auditada por cinco revisões independentes item a item contra `docs/CHECKLIST.md`. O que
segue é o resíduo dessas três passagens.

## O padrão que apareceu três vezes: teste verde sobre código que não funciona

Vale abrir com isto porque é o achado transversal da fase, e não é sobre nenhuma feature
em particular.

**1. O autosave nunca gravou bloco nenhum, e 21 suítes de teste passavam.**
Digitar A/Enter/B/Enter/C numa página nova deixava a tabela `blocks` vazia
(`select count(*)` = 0 depois de 2s, muito além do debounce de 600ms), com
`{"kind":"not_found","message":"não encontrado: bloco ativo <uuid>"}` no console — o erro
de `src-tauri/src/db/blocks.rs`. Duas causas somadas: a página vazia entrava com o
parágrafo-placeholder já na baseline de diff (a primeira digitação virava `update` de uma
linha que não existia), e o id era gerado no cliente e ignorado pelo backend, que gerava o
seu (a segunda digitação voltava a falhar). Corrigido nos dois lados (`NewBlock.id` /
`NewBlockInput::id`, baseline vazia em `use-blocks-document.ts`) e travado por
`core/use-blocks-document.test.tsx` e
`db_blocks.rs::create_honours_the_id_the_client_already_assigned`.
Nenhum teste de unidade pegava porque nenhum exercitava o ciclo completo
abrir-vazia → digitar → salvar → digitar → salvar. Quem encontrou foi um e2e.

**2. Quatro dos nove atalhos markdown não funcionavam, e ninguém tinha digitado um.**
`- `, `1. `, `[] ` e `> ` usavam `nodeInputRule`, que *insere um nó* — certo para um átomo,
errado para converter bloco de texto: `- ` não convertia nada e os outros três convertiam
mas perdiam o texto digitado depois do marcador. Junto, um segundo defeito em todos os
sete atalhos: `getAttributes: { id: newBlockId() }` é objeto literal, avaliado **uma vez**
quando `addInputRules()` roda, então todo bloco criado por aquele atalho nascia com o
mesmo id (e `unique-ids.ts` depois trocava o id do bloco, o que faz o autosave apagar e
recriar a linha). Corrigido com `blockShortcutRule` em `core/schema.ts`, que apaga o
marcador e relabela o bloco preservando o id que ele já tem. Travado por
`core/input-rules.test.ts` (13 casos, um por atalho, digitando de verdade pelo
`handleTextInput`).
As input rules tinham sido conferidas lendo o regex. O regex estava certo; o helper, não.

**3. FUN-044 nunca gerou um backlink sequer, e o teste Rust que deveria provar isso era
falso-verde.**
`0016_block_page_links.sql` extrai `jsonb_path_query(NEW.content, '$.**.pageId')` — só
reconhece a chave literal `"pageId"`. Mas o nó que o editor insere é `{ type: <menção>,
attrs: { id, label } }`, porque `MentionNodeAttrs` do `@tiptap/extension-mention` é sempre
`{id, label}`; e como `marks/mention-page/register.ts` não registra `BlockSpec`, esse JSON
é persistido verbatim dentro de `content.inline` do bloco pai. A árvore salva nunca contém
`"pageId"` para uma menção real: o gatilho nunca insere a linha, `list_backlinks` nunca
devolve nada, a seção "Backlinks" não aparece. O bloco `link_to_page` grava
`content.pageId` de fato e sempre funcionou — mas esse é FUN-043, outro item.

O teste que deveria ter pego, `src-tauri/tests/db_backlinks.rs` (`fn mention_block`),
fabricava à mão `"attrs": { "pageId": ... }` — uma forma que o cliente nunca produz.
Corrigido dos dois lados: o nó passou a carregar `pageId` explícito, escrito num único
ponto, e o teste passou a partir da forma real (trocar `pageId` por `pageIdX` no fixture
agora derruba 7 dos 9 testes).

**E ainda havia um segundo defeito escondido atrás desse**, que só apareceu depois de o
primeiro ser corrigido: `@tiptap/suggestion` usa `allowSpaces: false` por padrão (regex
`@[^\s@]*`), então o **primeiro espaço encerrava a busca** — a menção virava texto literal
`@E2E Glossário 1788...` no `plain_text`, nunca um chip. Isso inviabilizava EDT-044 para
praticamente todo título real, inclusive o padrão "Sem título".

A lição operacional das três: **teste que não atravessa a fronteira que a feature
atravessa não é prova.** Round trip de serialização não prova persistência; regex lido não
prova input rule; JSON fabricado não prova gatilho.

### O corolário: o isolamento por pasta esconde bug de integração

As 21 peças da Fase 2 foram construídas em pastas disjuntas, cada uma com o próprio teste
importando o próprio `register.ts`. Isso deixou o paralelismo seguro e escondeu isto:

`interaction/drag` insere a alça de arraste como widget em `pos + 1`, o que a torna o
**primeiro filho** de `.ed-block-wrapper`. `interaction/selection/selection-mouse.ts` lia
`firstElementChild` para descobrir de qual bloco o gesto partiu, encontrava um `<button>`
sem `data-block-id`, e saía por `if (!id) return false`. Com o app montado — as duas
extensões juntas, que é a única configuração que existe de verdade — **nenhum mousedown de
seleção funcionava**: EDT-053 e EDT-054 estavam mortos. Cada suíte passava sozinha.

O teste que fecha isso (`interaction/selection/selection-with-drag.test.ts`) importa os
**dois** `register.ts` e reprova 2 de 3 casos sem a correção. Vale como regra para as fases
seguintes: onde duas pastas disputam o mesmo DOM, o teste tem que montar as duas.

## Bloqueiam um usuário real

### 1. Mídia não grava fora de `$APPDATA/media`

`capabilities/default.json` concede `fs:scope` estático cobrindo `$APPDATA/media/**`, mas
`blocks/media/media-storage.ts` resolve o destino por `getDataDir() ?? appDataDir()`. Se o
usuário configurar uma pasta de dados customizada no assistente de primeira execução
(Fase 1, `save_data_dir`), a gravação cai fora do escopo e falha. O conserto correto é
estender o escopo em runtime pelo Rust (`app.fs_scope().allow_directory(...)`) no ponto em
que `save_data_dir` é tratado — `src-tauri/src/config/mod.rs`. Está documentado por
extenso na própria `description` do arquivo de capabilities.

### 2. DNS rebinding no cartão de bookmark

`isPrivateOrLoopbackHost` (`blocks/bookmark/bookmark-card.ts`) barra host privado no alvo
inicial e em cada hop de redirecionamento **antes** de discá-lo — o ACL do
`tauri-plugin-http` é checado uma única vez, contra a URL original, e nunca revalidado por
hop, então essa checagem no app é a única defesa que existe. Ela julga o hostname/IP
literal, e não resolve DNS: um hostname público cujo registro A aponta para um IP privado
passa. Fechar exigiria resolver o nome no Rust e julgar o IP resolvido.

Coberto: RFC1918, loopback `127/8` inteiro, link-local `169.254/16` (inclui o endpoint de
metadado de nuvem), `0/8`, CGNAT `100.64/10`, loopback e link-local e ULA IPv6, e IPv4
mapeado em IPv6. Não coberto: as faixas IPv6 exóticas (Teredo, 6to4 mapeando IPv4 privado,
NAT64) — risco residual aceito.

## Divergências entre o checklist e o repositório

Não são defeitos de código: são pontos onde `docs/CHECKLIST.md` e o código discordam, e a
discordância precisa de decisão de quem mantém o documento.

- **EDT-023** — o critério descreve o gatilho da equação inline como `$$expr$$` (dois
  cifrões). A implementação (`blocks/math/inline-math.ts`) usa **um** cifrão de cada lado.
  O caminho alternativo do próprio critério (Ctrl/Cmd+Shift+E) está implementado e testado.
- **EDT-061** — o checklist declara `e2e-webdriverio`, e não existe spec e2e para colar
  imagem. A prova real é `vitest` com `ClipboardEvent`/`DataTransfer` dublados (jsdom não
  os implementa). Ou se escreve o spec, ou o tipo declarado muda para `vitest` — como já
  aconteceu com 9 itens da Fase 1 (ver "Histórico de revisão" do checklist).
- **EDT-009** — o critério diz que marcar o to-do "reduz a opacidade". A implementação
  esmaece por mudança de cor para `--ink-muted`, não por `opacity`. Efeito visual
  equivalente; a palavra do critério, não.

## Cobertura que falta, sem defeito conhecido por baixo

- **EDT-074, metade cross-page.** A propagação de edição entre cópias no mesmo documento
  tem prova (`synced/live-mirror-extension.ts` + `synced-flow.test.tsx`), e a propagação no
  banco tem prova em `db_synced_blocks.rs`. O que não tem teste é "sem refresh manual" com
  duas páginas abertas ao mesmo tempo — e não tem porque `PageWorkspace.tsx` monta um único
  `<Editor>` por vez. A lacuna está documentada no próprio
  `live-mirror-extension.ts`.
- **EDT-027.** Nenhum teste clica em "Abrir" no bloco de arquivo. O bloco usa âncora HTML
  crua com `target="_blank"`+`download` apontando para `asset://`, enquanto
  `blocks/bookmark/open-url.ts` evita deliberadamente a âncora nativa e usa o plugin
  `opener`, com comentário explicando por quê. Os dois padrões divergem no mesmo
  repositório; vale unificar.
- **CSP e assetProtocol** não são observáveis por `vitest` (não roda dentro de um WebView) e
  `cargo build` só valida a sintaxe do identificador da permissão, não que o WebView de
  fato carrega a imagem pelo esquema `asset:`. Só o app rodando prova.
- **A lista de `deny` do `http:default`** foi validada sintaticamente pelo build; ninguém
  testou em runtime que o plugin recusa uma tentativa de bater em `127.0.0.1`.

## Testes

### O harness de e2e tinha três defeitos próprios

- **Encoding.** Os specs montavam SQL com título acentuado e passavam como argumento de
  linha de comando para o `psql`; no Windows o argumento vai na página de código ANSI, não
  UTF-8, e o servidor recusava os bytes (`invalid byte sequence for encoding "UTF8": 0xe1`).
  O erro saía no stderr e a spec, lendo só o stdout, enxergava string vazia — a asserção
  falhava dizendo a coisa errada, e quem lesse concluiria que o app não gravou.
  `e2e/lib/psql.mjs` manda o SQL por stdin como buffer UTF-8, com `PGCLIENTENCODING=UTF8` e
  `ON_ERROR_STOP=1` (para erro de SQL virar exceção em vez de stdout vazio).
- **CRLF na leitura.** No Windows o `psql` separa tuplas com `\r\n`. O jeito óbvio de
  partir a saída — `out.trim().split("\n")` — devolve `["A\r", "C\r", "B"]`, e a comparação
  falha em todas as linhas menos a última. O `.trim()` esconde o problema em consulta de
  **valor único** (só existe um `\r`, e é o último), que é exatamente por que passou batido:
  os specs verdes só liam um valor. Foi isto, e não o arrasto, que reprovou EDT-050/051 —
  DOM e Postgres já estavam em `A, C, B`. `psqlRows()` em `e2e/lib/psql.mjs` fecha.
- **API errada.** `block-selection.e2e.mjs` chamava `getRect()`, que não existe no elemento
  do WebdriverIO v9 (`getSize()`/`getLocation()`). As outras duas falhas do arquivo não
  eram cascata de sessão derrubada, como pareciam: os três `describe` rodavam o assistente
  de primeira execução, que só aparece **uma vez por sessão do app** — e é um app Tauri por
  spec.

### Um teste que falha dizendo a coisa errada é pior que um teste que não existe

Três das quatro classes de falha acima acusavam o produto por defeito do próprio harness: o
encoding fazia a asserção ler string vazia e concluir "o app não gravou"; o CRLF fazia
`["A\r","C\r","B"]` parecer ordem errada de blocos; o `aria-label` do botão da sidebar era
"Recolher" e não "Expandir" porque o item já estava expandido, e o teste concluiu que a
reparentagem de FUN-043 não tinha acontecido — quando o Postgres mostrava que tinha.

Custou uma rodada inteira de diagnóstico distinguir isso de bug real. A regra que fica: uma
asserção de e2e precisa reportar **o valor que encontrou**, não só "não apareceu" — foi
trocar `waitForDisplayed` por comparação de texto da seção que fez a diferença entre "1
backlink" e "seção vazia" aparecer no log.

### Uma corrida real que o e2e expôs, e que valia consertar no produto

Depois de tudo verde, uma execução independente reprovou FUN-044 com "1 backlink" em vez de
"2": a menção feita na página anterior ainda não tinha chegado ao banco. Sair de uma página
dispara o autosave dela pela limpeza de efeito do editor, e limpeza de efeito no React não
pode ser `async` — o `flush()` sai sem ninguém esperando. A gravação acontece; o rodapé de
backlinks da página seguinte só a lê se ela chegar antes, e como esse rodapé busca uma única
vez ao montar, o número errado ficava na tela até recarregar.

Consertado no produto, não afrouxando o teste: `whenBlockWritesSettle()`
(`core/blocks-api.ts`) encadeia toda escrita de bloco já disparada, e `BacklinksSection`
espera essa barreira antes de perguntar quem menciona a página. Na mão do usuário o sintoma
era "mencionei a página e o backlink não apareceu".

### O placar real

Suíte e2e completa contra o app (WebView2 + Postgres real), sem `E2E_SKIP_BUILD`: **8 de 8
specs, 25 testes, exit 0**, em 53 segundos. A primeira execução da fase levava 55 minutos —
aqueles eram timeout de uma sessão WebView2 derrubada, não trabalho.

Portão de unidade no fechamento desta fase: `tsc --noEmit` exit 0; `vitest` 646 testes em
85 arquivos, 0 falhas; `cargo test -- --include-ignored` 219 passando; `cargo clippy
--all-targets --all-features -D warnings` com `unwrap_used`/`expect_used` banidos, limpo.

### Flake conhecido

`src/features/search/SearchPalette.test.tsx` falhou **uma vez** numa suíte completa e
passou em cinco execuções isoladas seguidas. É corrida de `userEvent`/`findByText` sob
carga, anterior a esta fase e não investigada além disso.

## Ambiente

O disco `C:` encheu (0 bytes livres) no meio da sessão e chegou a bloquear até edição de
arquivo. Foram liberados 18,3 GB apagando **apenas**
`src-tauri/target/debug/incremental` (7,15 GB de cache do compilador Rust, regenerável).
Hoje restam ~12 GB livres de 477 GB, e o cache volta a crescer a cada build — vale limpar
periodicamente ou mover o `target/` para outro volume via `CARGO_TARGET_DIR`.

## Dependências

`npm audit` acusa 15 vulnerabilidades (14 altas, 1 moderada), **todas** na cadeia do
WebdriverIO — `@wdio/*`, `webdriverio`, `webdriver`, `expect-webdriverio`,
`@puppeteer/browsers`, `extract-zip`, `deepmerge-ts`, `mocha`, `serialize-javascript`. É
devDependency de teste e2e; nenhuma dependência de runtime está afetada. A Fase 1 fechou com
`found 0 vulnerabilities` porque o WebdriverIO ainda não estava instalado.
