# Editor de blocos — como estender sem editar `core/`

Este editor é TipTap/ProseMirror por baixo, mas o modelo de dados não é o
document tree padrão do TipTap — é uma árvore de blocos (Notion-like), cada
bloco com um `id` estável, um `blockType`, um `content` opaco e um
`parentBlockId` opcional. `contract.ts` define essa forma; `core/schema.ts`
implementa como tipos de nó ProseMirror; `core/serialize.ts` traduz entre as
duas direções (doc → `Block[]` ao salvar, `Block[]` → doc ao abrir).

**A decisão que sustenta tudo:** todo tipo de bloco (não só toggle, não só
lista) tem o mesmo modelo de conteúdo — `"inline* childBlocks?"`. Isso é o
que deixa Tab/Shift+Tab (EDT-067/068) indentar *qualquer* bloco sob o irmão
anterior, e toggle (EDT-010) aninhar filhos, sem duas implementações
separadas. Se você adicionar um bloco novo (tabela, imagem, database inline)
e ele **não** seguir esse modelo — porque tem conteúdo estruturado demais
para caber em `"inline* childBlocks?"` — ele ainda pode ser seu próprio tipo
de nó com um `content` diferente, só não ganha indentação genérica de graça;
implemente Tab/Shift+Tab próprios se precisar deles.

## Como registrar sem tocar em `core/`

Você **nunca** edita `core/schema.ts`, `core/serialize.ts`, `core/keymap.ts`,
`core/editor.css` ou `core/Editor.tsx` para adicionar uma marca, um bloco, um
comportamento de interação, um item de menu ou um painel flutuante. Em vez
disso:

1. Crie sua pasta ao lado de `core/` — `marks/`, `blocks/`, `interaction/`
   ou `synced/` — se ainda não existir.
2. Dentro dela, um arquivo `register.ts` (pode estar em qualquer
   subdiretório dentro da pasta — `marks/color/register.ts` funciona) cujo
   corpo, ao ser importado, chama as funções de registro:

   ```ts
   // src/features/editor/marks/highlight/register.ts
   import { Mark } from "@tiptap/core";
   import { registerBlockExtension } from "../../core/registry";
   import { registerFormattingMenuItem } from "../../core/block-spec";

   export const Highlight = Mark.create({ name: "highlight", /* ... */ });

   registerBlockExtension(Highlight); // aceita uma extensão ou um array
   registerFormattingMenuItem({ id: "marks:highlight", render: (editor) => /* ... */ });
   ```

3. Não precisa importar esse arquivo de lugar nenhum.
   `core/discover-extensions.ts` usa `import.meta.glob` para carregar todo
   `**/register.ts` sob `marks/`, `blocks/`, `interaction/` e `synced/`
   automaticamente, antes do `Editor` montar.

**Importe de `../../core/<módulo>`, nunca de `../../index`.** O barrel
`index.ts` é a porta de entrada do *app* para o editor (`PageWorkspace`
importa `Editor` de lá). Um `register.ts` que importasse dele fecharia um
ciclo — `index` → `Editor` → `discover-extensions` → seu `register.ts` →
`index` — e o ciclo estoura em TDZ dependendo da ordem de avaliação dos
módulos. Importar direto de `core/registry`, `core/block-spec` e
`core/commands` não fecha ciclo nenhum: são folhas do grafo.

**Uma pegadinha do `import.meta.glob`:** o padrão do glob é resolvido pelo
Vite quando o dev server sobe (ou no build) — uma pasta que **ainda não
existe** só entra depois de reiniciar o `npm run dev`. Se você acabou de
criar `src/features/editor/blocks/` pela primeira vez, reinicie o dev
server uma vez; edições subsequentes dentro da pasta já recarregam
normalmente.

## Os seis pontos de extensão

Todos vivem em `core/block-spec.ts`, menos o primeiro (`core/registry.ts`).

### 1. `registerBlockExtension(extension)` — a extensão TipTap em si

Um `Mark`, um `Node` ou uma `Extension`. É o que entra na lista de extensões
que `Editor` monta. Sozinho, basta para uma marca de texto e para
comportamento de interação; **não** basta para um tipo de bloco novo.

### 2. `registerBlockSpec(spec)` — como o bloco é persistido

Um `Node` novo sem `BlockSpec` correspondente é salvo como `"paragraph"`,
silenciosamente — seu conteúdo se perde na primeira gravação. O `BlockSpec`
é o que fecha esse buraco, e é a única coisa que `serialize.ts` sabe sobre
tipos de bloco (ele não tem lista de tipos nenhuma; lê tudo do registro).

```ts
registerBlockSpec({
  blockType: "image",        // vocabulário persistido em Block.blockType
  nodeName: "image",         // nome do nó ProseMirror
  hasContent: false,         // átomo: o nó não tem content array
  serialization: {
    attrs: (_blockType, content) => ({ src: content.src, caption: content.caption }),
    content: (attrs) => ({ src: attrs.src, caption: attrs.caption }),
    plainText: (content) => String(content.caption ?? ""),
  },
});
```

Defaults, quando você omite: `attrs` → `{}`; `blockType` → o `spec.blockType`
fixo; `content` → `{ inline: nodeContent }`; `nodeContent` →
`content.inline`; `plainText` → o texto inline achatado. Ou seja: um bloco
textual comum precisa só de `{ blockType, nodeName }`.

`attrs` recebe um terceiro argumento, o `Block` inteiro, para os campos que
são **coluna** e não parte de `content` — `syncedSourceId` acima de tudo, que
o node view de um bloco sincronizado precisa ler para mostrar o indicador
(EDT-073) e que nenhuma leitura de `content` alcança. É via de mão única:
`content()` não escreve `syncedSourceId` de volta, porque ele não está no
JSONB; quem escreve são os comandos dedicados (`create_synced_block_copy`,
`unsync_block`).

`matches(blockType)` existe para uma *família* de tipos que compartilha um nó
(heading usa: um spec cobre `heading_1|2|3`). Registrar dois specs com o
mesmo `blockType` e `nodeName` diferentes **lança erro** — seria corrupção de
documento salvo, não uma preferência.

### 3. `registerSlashMenuItem(item)` — entrada do menu `/` (EDT-047)

```ts
registerSlashMenuItem({
  id: "blocks:image",           // único entre todos os construtores
  title: "Imagem",
  keywords: ["imagem", "image", "foto"],
  group: "Mídia",
  icon: "🖼",
  run: (editor) => insertBlockHere(editor, "image"),
});
```

### 4. `registerTurnIntoItem(item)` — entrada de "Turn into" (EDT-049)

Mesma forma, mais `isActive(editor)`. Só faz sentido para um tipo em que
converter *preservando o conteúdo* faz sentido (texto → título, sim;
parágrafo → tabela, não).

### 5. `registerFormattingMenuItem(item)` e `registerEditorOverlay(overlay)` — UI

`FormattingMenuItem` é um botão na **única** barra flutuante de seleção que
`Editor` renderiza — um registro em vez de "cada construtor monta sua própria
`BubbleMenu`", porque N barras flutuantes disputando a mesma seleção é N
barras na tela. `EditorOverlay` é painel livre montado ao lado do conteúdo,
para o que não é botão de barra: o popup do menu `/`, um editor de link, um
diálogo de legenda.

Ambos recebem o `editor` e devolvem `ReactNode`.

### 6. `registerInlinePlainText(entry)` — texto de busca de um nó inline

`Block.plainText` é o que a busca global (FUN-037) indexa, e o achatador
padrão só entende nó de texto e quebra de linha. Um átomo inline — chip de
data, equação inline, menção de página — não contribuía nada e ficava
invisível para a busca, por mais texto que mostrasse na tela. Declare como
ler o seu:

```ts
registerInlinePlainText({
  nodeName: "dateMention",
  text: (node) => String(node.attrs?.isoDate ?? ""),
});
```

## Primitivas prontas em `core/commands.ts`

Não reimplemente cirurgia de árvore: `turnCurrentBlockInto(editor, nodeName,
attrs)` troca o tipo do bloco sob o cursor preservando id e texto;
`insertBlockHere(editor, nodeName, attrs, content?)` converte o bloco quando
ele está vazio (o caso do menu `/`) e insere um irmão abaixo quando ele tem
texto; `contentDepthOf(editor)` / `currentBlockNode(editor)` dão o nó
`blockContent` sob o cursor; `clearSlashQuery(editor, len)` apaga o `/` e o
texto de filtro antes de agir.

`insertBlockHere` honra um `id` que você passe em `attrs` — gere com
`newBlockId()` e passe, quando precisar referenciar depois o bloco que
acabou de inserir (gravar a linha de link, colar a cópia sincronizada), em
vez de caçar no doc um bloco que você não sabe identificar.

## Qual página está aberta: `pageIdOf(editor)`

`core/page-context.ts` expõe o `pageId` da instância do editor a qualquer
extensão — `create_synced_block_copy` precisa de `placement.pageId`, o bloco
link-to-page precisa reparentear sob *esta* página, um bloco de mídia grava
na subpasta da página. É storage por instância de editor (uma segunda página
aberta num segundo editor tem o seu), não variável de módulo. **Trate o
`null`:** ele é `null` num teste que monta editor sem página e na instância
de carregamento, e uma extensão que assume página aberta quebra o editor
exatamente onde nada está aberto ainda.

## O que cada pasta ganha "de graça"

- **Marcas de texto** (negrito, cor, link, menção): declare `group: "inline"`
  no seu `Mark`/`Node` e ele passa a valer em qualquer bloco de texto — o
  conteúdo deles já é `"inline*"`, sem precisar listar cada tipo de bloco
  manualmente. Note que `StarterKit` está configurado com `bold`, `italic`,
  `strike`, `code`, `underline` e `link` **desligados** (ver
  `core/extensions.ts`): quem quiser essas marcas registra a extensão oficial
  correspondente, para que a marca e o botão dela na barra nasçam do mesmo
  lugar.
- **Blocos ricos** (imagem, tabela, equação): registre um `Node` com
  `group: "blockContent"` — **não** `group: "block"`. O grupo `"block"` é do
  wrapper genérico `Block` (`schema.ts`), que é quem carrega o `id` e os
  filhos; um nó no grupo `"block"` apareceria solto sob `doc` e
  `docToFlatBlocks` o ignoraria em silêncio por não achar `attrs.id` no lugar
  esperado. Sendo `"blockContent"`, seu nó nasce dentro do wrapper e ganha
  id, aninhamento e serialização genérica. Some isso ao `BlockSpec` do item 2
  e o ciclo salvar/abrir fecha.
- **CSS**: crie o seu ao lado do seu código (`blocks/image/image.css`) e
  importe do seu próprio módulo. `core/editor.css` é do core.
- **Interação** (drag-and-drop, seleção múltipla, colar): normalmente uma
  `Extension` com `addProseMirrorPlugins`/`addKeyboardShortcuts` própria —
  não precisa mexer em `core/keymap.ts`, que é só o Enter/Tab/Backspace
  estrutural. Para colar (EDT-030/EDT-061), use `props.handlePaste` no seu
  próprio plugin: vários plugins encadeiam naturalmente, o primeiro que
  devolve `true` vence.
- **Blocos sincronizados**: um `blockType` como qualquer outro do ponto de
  vista de `serialize.ts` (ele já trafega `syncedSourceId` em `Block` —
  ver `contract.ts`); a lógica de "editar uma cópia atualiza as outras" já
  está pronta no backend (`ipc/block_commands.rs`:
  `create_synced_block_copy`, `unsync_block`, `unsync_all_synced_copies`,
  `count_synced_copies`, `delete_synced_original`) — a extensão precisa
  chamar esses comandos, não reimplementar a propagação.

## Onde não esperar generalidade

- `core/commands.ts` decide "isto é um bloco?" pelo **grupo** do nó
  (`isBlockContentType`, em `core/node-names.ts`), não por uma lista fixa —
  então Enter/Tab/Shift-Tab/Backspace valem para o seu bloco novo também,
  *contanto que* o `content` dele seja `"inline*"` como os demais. Um bloco
  com forma de conteúdo diferente (uma tabela) precisa dos próprios atalhos.
  O mesmo vale para o reparo de id duplicado ao colar (`core/unique-ids.ts`):
  qualquer nó do grupo `blockContent` ganha id novo, não só os nove do core.
- O que continua sendo lista fixa é o **comportamento** que o core codifica
  por tipo: quais tipos repetem no Enter (`LIST_ITEM_NODE_NAMES`) e quais
  rebaixam no Backspace (`DEMOTABLE_NODE_NAMES`), em `core/node-names.ts`.
  Seu bloco não entra nessas duas listas — se ele precisar desse
  comportamento, implemente no seu próprio keymap.
- Um bloco cujo próprio pai (não ele) já tem filhos, ao ter Enter
  pressionado no meio do seu texto, entrega esses filhos ao segundo pedaço
  do split em vez de mantê-los no primeiro — documentado em
  `commands.ts`'s `splitBlock`. Nenhum critério da Fase 2 exercita esse
  caminho; se um bloco novo depender dele, resolva ali, não aqui.

## Onde os blocos são gravados de verdade

`core/blocks-api.ts` escolhe em tempo de execução: dentro do app Tauri
(`isTauri()`), os seis comandos de `contract.ts` vão para o Postgres via
`invoke`; fora dele — `vite dev` num browser comum e **todo `vitest`** — cai
num stub em `localStorage` com o mesmo contrato. Seu teste de unidade,
portanto, nunca precisa de banco; seu teste e2e, que roda dentro do app,
sempre bate no banco real.
