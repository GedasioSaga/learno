# HANDOFF — Learno

## Objetivo

Construir o Learno: um aplicativo de desktop para estudo que funde, num único produto,
um editor de blocos no modelo do Notion, um sistema de repetição espaçada no modelo do
Anki, um editor de mapa mental e um temporizador Pomodoro.

A tese do produto está na integração, não na soma: o flashcard nasce dentro da nota.
Selecionar um trecho cria um card; o cloze é marcado inline no próprio bloco; o card
guarda uma referência viva ao bloco de origem, de modo que editar a nota atualiza o
card; e a coleção de cards é exposta como uma database nativa do lado Notion, com
vencimento, intervalo e facilidade virando propriedades filtráveis. Um nó do mapa
mental também vira card, e o Pomodoro se vincula à página aberta ou ao baralho em
estudo.

`docs/CHECKLIST.md` é a régua: 563 itens, 345 essenciais, distribuídos em 6 fases, cada
um com critério de aceite no formato Dado/Quando/Então e o tipo de teste que o prova.

## Decisões travadas (grilling de 02/09/2026)

| Decisão | Escolha | Alternativa recusada |
|---|---|---|
| Persistência | PostgreSQL 18 local como banco principal | SQLite embutido com sync posterior |
| Papel do Python | Sidecar PyInstaller para tarefas pesadas | FastAPI como camada de dados |
| Escopo v1 | Núcleo + avançado, usuário único | Paridade total com tempo real e nuvem |
| Editor | TipTap sobre ProseMirror | BlockNote, Lexical, contenteditable próprio |
| Ponte nota-card | Integração profunda, card vive na nota | Mundos separados |
| Mapa mental | Canvas livre com nós ancorados, bidirecional | Projeção automática apenas |
| Visual | Híbrido cozy-produtivo | Pixel-art integral; Notion neutro |
| Local do repo | `C:/dev/learno`, fora do OneDrive | Dentro da pasta sincronizada |
| Cadência | Checkpoint ao fim de cada uma das 6 fases | Autônomo até o fim |

Decisão nova da sessão da Fase 2, que faltava e custou caro: **o id de um bloco é gerado
pelo cliente e honrado pelo backend** (`NewBlock.id` / `NewBlockInput::id`). O nó
ProseMirror ganha id no instante em que é digitado e toda edição posterior se refere a ele
por esse id; um backend que gerasse o seu próprio deixava o editor mandando UPDATE de uma
linha inexistente — e foi exatamente o que aconteceu, ver a evidência ao final.

## Estado atual

Fase 1 fechada (29/29 itens). **Fase 2 fechada (66/66 itens)**, construída nesta sessão e
ainda **não commitada** — a árvore inteira é trabalho em progresso, ~40 arquivos entre
modificados e novos.

### Núcleo do editor — `src/features/editor/core/`

Modelo de dados próprio (árvore de blocos com `id`/`blockType`/`content`/`parentBlockId`)
sobre TipTap 3.31. O contrato de extensão está em `src/features/editor/README.md`, e o
ponto dele é que **nenhum tipo de bloco novo edita `core/`**:

- `core/block-spec.ts` — seis pontos de registro: `registerBlockExtension`,
  `registerBlockSpec` (como o bloco é persistido), `registerSlashMenuItem`,
  `registerTurnIntoItem`, `registerFormattingMenuItem` / `registerEditorOverlay`, e
  `registerInlinePlainText` (texto de busca de nó inline atômico).
- `core/serialize.ts` — não tem lista de tipos de bloco nenhuma; lê tudo do registro.
- `core/commands.ts` — primitivas públicas `turnCurrentBlockInto`, `insertBlockHere`,
  `contentDepthOf`, `currentBlockNode`, `clearSlashQuery`.
- `core/schema.ts` — os nove tipos estruturais e `blockShortcutRule`, o helper de atalho
  markdown que relabela o bloco preservando o id.
- `core/page-context.ts` — `pageIdOf(editor)`, o canal que faltava entre o editor e as
  extensões que precisam saber qual página está aberta.
- `core/blocks-api.ts` — IPC real dentro do Tauri (`isTauri()`), stub em `localStorage`
  fora dele (browser e vitest), e `whenBlockWritesSettle()`, a barreira que ordena leitura
  depois de escrita.

### As 21 peças da Fase 2 — pastas disjuntas sob `src/features/editor/`

`marks/` (basic, color, script, link, mention-page, mention-date) ·
`blocks/` (code, math, media, bookmark, table, toc, columns, page-link) ·
`interaction/` (slash-menu, turn-into, drag, selection, keys) ·
`synced/` · `src/features/pages/backlinks/`.

### Backend Rust

Camada de blocos completa e provada contra Postgres real: `src-tauri/src/db/blocks.rs`,
`db/backlinks.rs`, `ipc/block_commands.rs`, migração `0016_block_page_links.sql`. As
capabilities do Tauri passaram a declarar `fs`, `dialog` e `http` com escopo mínimo, e o
`assetProtocol` foi habilitado para os blocos de mídia.

## Próximos passos

1. Commitar a Fase 2 (nada está commitado ainda) e fazer o checkpoint com o usuário — é a
   cadência acordada no grilling: um checkpoint ao fim de cada uma das 6 fases.
2. Decidir as três divergências entre o checklist e o código registradas em
   `docs/ACHADOS-FASE-2.md` (gatilho da equação inline, tipo de teste de EDT-061, palavra
   "opacidade" em EDT-009): ou o código muda, ou o texto do critério muda.
3. Fase 3 — databases e views, 79 itens, todos essenciais. É a fase que transforma a
   coleção de cards numa database nativa do lado Notion, então é pré-requisito da tese do
   produto tanto quanto a Fase 4.
4. Fases 4 (SRS/Anki, 118), 5 (mapa mental e Pomodoro, 52) e 6 (polimento e instalador,
   219), com checkpoint ao fim de cada uma.

Duas dívidas da Fase 2 que valem entrar no escopo da fase que as tocar primeiro, não antes:
estender o `fs:scope` em runtime quando o usuário configura pasta de dados customizada
(morre na Fase 6, com o instalador), e resolver DNS no Rust para fechar o DNS rebinding do
cartão de bookmark.

## Critério de pronto

O loop encerra quando 100% dos itens marcados como essenciais em `docs/CHECKLIST.md`
passam no teste declarado para cada um. Para a Fase 2 especificamente: os 66 itens da
fase, com o tipo de teste que cada um declara (`vitest`, `cargo-test`,
`e2e-webdriverio`) de fato executado e verde — não "o código existe". Esse critério está
cumprido; a coluna **Feito** da Fase 2 no checklist foi preenchida item a item lendo o
código, não a suíte, por cinco revisões independentes.

## Evidência

- **Portão completo no fechamento da Fase 2:**
  `rtk proxy npx tsc --noEmit` exit 0;
  `npx vitest run` → 85 arquivos, 646 testes, 0 falhas;
  `cargo test -- --include-ignored` → 219 passed, 11 suítes, exit 0;
  `cargo clippy --all-targets --all-features -- -D warnings -W clippy::unwrap_used
  -W clippy::expect_used` limpo;
  `npx wdio run ./e2e/wdio.conf.mjs` (sem `E2E_SKIP_BUILD`, binário recompilado) →
  **8 de 8 specs, 25 testes, exit 0**, em 53s.
- **Os testes Rust rodaram de verdade contra banco vivo, não foram pulados:**
  `cargo test --test db_blocks -- --include-ignored` → `9 passed; 0 failed; 0 ignored`;
  o mesmo comando sem `--include-ignored` → `0 passed; 8 ignored`. Cluster descartável
  na porta 5433 (`scripts/dev-db.ps1 start`).
- **Os três defeitos que passavam por 640 testes verdes**, cada um reproduzido antes de
  ser corrigido e travado por teste depois — relato completo em `docs/ACHADOS-FASE-2.md`:
  1. o autosave nunca gravava bloco nenhum no app real
     (`select count(*) from blocks` = 0 depois de digitar; `not_found: bloco ativo <uuid>`
     de `src-tauri/src/db/blocks.rs`);
  2. quatro dos nove atalhos markdown não funcionavam (`- ` não convertia; `1. `, `[] `,
     `> ` perdiam o texto), e todos os sete compartilhavam um mesmo id gerado uma única
     vez no registro da extensão;
  3. a @-menção nunca gerava backlink (chave `id` no nó contra `pageId` no gatilho da
     migração), com o teste Rust correspondente fabricando um JSON que o cliente nunca
     produz — trocar `pageId` por `pageIdX` no fixture corrigido agora derruba 7 dos 9
     testes.
- **Bug no `handleTab` do core:** indentar um bloco sob um irmão que já tinha filhos
  inseria um nível raso demais e o Tab silenciosamente não fazia nada. Reproduzido em
  `core/commands.test.ts` ("Tab sob um irmão que já tem filhos"), corrigido, 13/13.
- **Bug de integração que o isolamento por pasta escondia:** a alça de arraste
  (`interaction/drag`) é o primeiro filho do wrapper do bloco, e
  `interaction/selection/selection-mouse.ts` lia `firstElementChild` — com o app montado,
  nenhum mousedown de seleção funcionava. Cada suíte passava sozinha;
  `selection-with-drag.test.ts` monta as duas e reprova 2 de 3 casos sem a correção.
- **SSRF no cartão de bookmark, fechado por hop:** o ACL do `tauri-plugin-http` é checado
  uma única vez contra a URL original e nunca revalidado por redirecionamento (confirmado
  no código do plugin). Validar só o destino final impediria exibir conteúdo interno, mas
  o host interno já teria sido requisitado. `maxRedirections: 0` mais validação de cada
  hop antes de discá-lo; o teste afirma `toHaveBeenCalledTimes(1)` com a URL pública.
- **Corrida de escrita fechada no produto, não no teste:** `whenBlockWritesSettle()`
  (`core/blocks-api.ts`) encadeia toda escrita de bloco disparada, e `BacklinksSection`
  espera essa barreira — a limpeza de efeito do React não pode ser `async`, então o
  autosave da página anterior saía sem ninguém esperando e o rodapé mostrava um backlink
  a menos.
- **Isolamento das 21 peças paralelas:** `git status --short` depois da rodada mostrou
  escrita apenas em pastas novas, mais `PageWorkspace.tsx`/`.test.tsx` (a única peça
  autorizada a sair da própria pasta). Nenhuma peça editou `core/`.
- **Dívida conhecida:** `npm audit` acusa 15 vulnerabilidades, todas na cadeia do
  WebdriverIO (devDependency de e2e); nenhuma em dependência de runtime. O disco `C:`
  encheu durante a sessão e foram liberados 18,3 GB apagando só
  `src-tauri/target/debug/incremental`; restam ~12 GB de 477 GB e o cache volta a crescer.
