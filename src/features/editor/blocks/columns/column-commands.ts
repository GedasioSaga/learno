/**
 * Cirurgia de árvore desta peça, no mesmo espírito de `core/commands.ts`:
 * funções puras (recebem `Editor`, devolvem `boolean`) que manipulam a
 * transação do ProseMirror diretamente, para não reimplementar mal o que já
 * existe. Duas famílias de operação:
 *
 * - `wrapBlocksInColumns`/`wrapCurrentBlockInColumns`: criam o layout de
 *   duas colunas. A primeira é chamada por `interaction/drag/
 *   drag-extension.ts` quando um bloco é solto na faixa estreita perto da
 *   borda direita de outro (a zona `{ kind: "columns" }` que
 *   `interaction/drag/drop-zone.ts` resolve - EDT-033 e EDT-051, "soltar na
 *   metade direita", coexistiam mal com só duas zonas; agora são três, ver o
 *   comentário de `drop-zone.ts`). A segunda é o caminho sem mouse (EDT-033
 *   exige um: "um critério que só pode ser cumprido arrastando não é
 *   testável").
 * - `resizeColumnBoundary`: move a fronteira entre duas colunas vizinhas,
 *   chamada tanto pela alça de arraste quanto pelas setas do teclado (ambas
 *   em `column-node-view.ts`).
 *
 * Como localizar um `column` (ou qualquer bloco) pela `Block.id` persistida:
 * `column`/`columnList` são nós de conteúdo vazio (`content: ""` -
 * `column-nodes.ts`), o que os torna "leaf" no vocabulário do ProseMirror
 * (`NodeType.isLeaf`, `nodeSize === 1`) - bem diferente de um bloco textual
 * como paragraph/heading, que tem texto "dentro". Por isso as funções aqui
 * NUNCA resolvem "um passo para dentro" do jeito que `contentDepthOf` faz em
 * `core/commands.ts` (isso pressupõe um nó com conteúdo real) - elas
 * resolvem exatamente na posição que antecede o nó (a mesma que
 * `Node.descendants` entrega), onde `$pos.depth` já é a profundidade do
 * `Block` wrapper que o contém. `wrapperContextOf` é essa diferença,
 * documentada uma vez para não repetir o raciocínio em cada função.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { contentDepthOf } from "../../core/commands";
import { newBlockId } from "../../core/ids";
import { NODE_NAMES } from "../../core/node-names";
import {
  COLUMN_MIN_WIDTH,
  COLUMN_NODE_NAME,
  COLUMN_LIST_NODE_NAME,
  DEFAULT_COLUMN_WIDTH,
} from "./node-names";

/** `content.width`/`attrs.width` só é confiável depois de passar por aqui - um documento salvo por uma versão futura, ou um attr nunca definido, não pode virar `NaN`/`undefined` na tela. */
export function coerceWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_COLUMN_WIDTH;
}

function widthOf(node: PMNode): number {
  return coerceWidth(node.attrs.width);
}

function roundWidth(width: number): number {
  // Quatro casas decimais bastam (0.01% de resolução) e evitam que somas
  // sucessivas de ponto flutuante acumulem ruído a cada arraste.
  return Math.round(width * 10000) / 10000;
}

interface WrapperContext {
  /** Posição logo antes do `Block` wrapper que contém o nó consultado. */
  wrapperPos: number;
  wrapperNode: PMNode;
  /** O `childBlocks` que é pai desse wrapper - a lista de irmãos. */
  childBlocksNode: PMNode;
  /** Índice do wrapper dentro de `childBlocksNode`. */
  index: number;
}

/**
 * Onde o `Block` wrapper de um nó "leaf" (`column`/`columnList`) vive, e a
 * lista de irmãos (`childBlocks`) a que ele pertence. `leafPos` é a posição
 * que antecede o próprio nó folha - a que `Node.descendants`/`getPos()`
 * devolvem - nunca uma posição "dentro" dele (ver o comentário do arquivo).
 * `null` quando o nó não está de fato aninhado num `childBlocks` (documento
 * corrompido ou nó ainda não inserido).
 */
function wrapperContextOf(doc: PMNode, leafPos: number): WrapperContext | null {
  const $at = doc.resolve(leafPos);
  const wrapperDepth = $at.depth;
  if (wrapperDepth < 1) return null;
  const childBlocksDepth = wrapperDepth - 1;
  if (childBlocksDepth < 1) return null;
  const childBlocksNode = $at.node(childBlocksDepth);
  if (childBlocksNode.type.name !== NODE_NAMES.childBlocks) return null;
  return {
    wrapperPos: $at.before(wrapperDepth),
    wrapperNode: $at.node(wrapperDepth),
    childBlocksNode,
    index: $at.index(childBlocksDepth),
  };
}

interface FoundNode {
  pos: number;
  node: PMNode;
}

/**
 * Primeiro descendente que casa `predicate`, percorrendo o doc inteiro -
 * mesmo idioma de busca que `commands.test.ts` (`startOfBlock`) já usa neste
 * projeto: `return false` no achado impede descer nos filhos dele, mas não
 * interrompe a varredura dos irmãos seguintes (`Node.descendants` não tem
 * "parar de vez"); aceitável aqui pelo mesmo motivo que lá - documentos de
 * página são pequenos, e simplicidade vence uma micro-otimização.
 *
 * O resultado sai por um array (não um `let` reatribuído dentro do closure)
 * de propósito: o TypeScript deste projeto (~5.8) estreita o tipo de uma
 * variável assim mutada para `never` na leitura logo após
 * `doc.descendants(...)`, quando o valor atribuído é um objeto (reproduzido
 * isoladamente antes de escrever isto - `tsc` acusava `Property 'pos' does
 * not exist on type 'never'` num `let found: {pos,node}|null` idêntico a
 * este) - indexar um array não tem esse problema.
 */
function firstDescendantMatching(doc: PMNode, predicate: (node: PMNode) => boolean): FoundNode | null {
  const matches: FoundNode[] = [];
  doc.descendants((node, pos) => {
    if (matches.length > 0) return false;
    if (predicate(node)) {
      matches.push({ pos, node });
      return false;
    }
    return true;
  });
  return matches[0] ?? null;
}

interface LocatedColumn {
  leafPos: number;
  columnNode: PMNode;
  context: WrapperContext;
}

/** Acha um `column` pelo seu próprio `Block.id`. */
function locateColumnById(doc: PMNode, columnBlockId: string): LocatedColumn | null {
  const found = firstDescendantMatching(
    doc,
    (node) => node.type.name === COLUMN_NODE_NAME && node.attrs.id === columnBlockId,
  );
  if (!found) return null;
  const context = wrapperContextOf(doc, found.pos);
  if (!context) return null;
  return { leafPos: found.pos, columnNode: found.node, context };
}

interface LocatedWrapper {
  /** Posição logo antes do `Block` wrapper inteiro (não do seu conteúdo). */
  pos: number;
  node: PMNode;
}

/** Acha o `Block` wrapper de QUALQUER bloco (não só coluna) pelo seu id - a busca que `wrapBlocksInColumns` precisa para pegar o bloco inteiro (texto + filhos aninhados que ele já tinha) e não só seu texto. */
function locateBlockWrapper(doc: PMNode, blockId: string): LocatedWrapper | null {
  return firstDescendantMatching(
    doc,
    (node) => node.type.name === NODE_NAMES.block && node.firstChild?.attrs.id === blockId,
  );
}

function rangesOverlap(a: LocatedWrapper, b: LocatedWrapper): boolean {
  const aEnd = a.pos + a.node.nodeSize;
  const bEnd = b.pos + b.node.nodeSize;
  return a.pos < bEnd && b.pos < aEnd;
}

/**
 * Monta o `Block` wrapper de `columnList` inteiro: `columnList` (átomo) +
 * `childBlocks` com N colunas (N = `blocks.length`, `ChildBlocks.content` é
 * `"block+"` em `core/schema.ts` - sem teto), cada uma por sua vez um
 * `Block` wrapper de `column` (átomo) + `childBlocks` com o bloco original
 * dela dentro. Os blocos originais entram inteiros, filhos aninhados
 * incluídos - "envolver em colunas" nunca descarta conteúdo. Largura inicial
 * dividida em partes iguais entre as N colunas (não `DEFAULT_COLUMN_WIDTH`
 * fixo, que só faz sentido para duas: 0.5 + 0.5 = 1, mas 0.5 x3 não soma 1).
 */
function buildColumnListWrapper(schema: Schema, blocks: PMNode[]): PMNode {
  const columnListType = schema.nodes[COLUMN_LIST_NODE_NAME];
  const columnType = schema.nodes[COLUMN_NODE_NAME];
  const blockType = schema.nodes[NODE_NAMES.block];
  const childBlocksType = schema.nodes[NODE_NAMES.childBlocks];
  const equalWidth = roundWidth(1 / blocks.length);

  const oneColumn = (block: PMNode): PMNode =>
    blockType.create(null, [
      columnType.create({ id: newBlockId(), width: equalWidth }),
      childBlocksType.create(null, block),
    ]);

  const columnsRow = childBlocksType.create(null, blocks.map(oneColumn));
  return blockType.create(null, [columnListType.create({ id: newBlockId() }), columnsRow]);
}

/**
 * EDT-033: a transformação de árvore chamada por `interaction/drag/
 * drag-extension.ts` ao soltar um bloco na faixa de colunas de outro (zona
 * `{ kind: "columns" }` de `drop-zone.ts`). NÃO implementa o gesto de
 * arrastar em si (não é responsabilidade desta peça - ver README da tarefa)
 * - só a cirurgia: pega os dois blocos existentes pelo id, remove
 * `incomingBlockId` de onde estava e recria os dois lado a lado dentro de
 * um `columnList` novo, no lugar onde `targetBlockId` estava.
 * `targetBlockId` vira a coluna esquerda, `incomingBlockId` a direita.
 *
 * `targetBlockId` = bloco já no lugar onde o usuário soltou; `incomingBlockId`
 * = bloco sendo arrastado.
 *
 * Recusa (devolve `false`, não faz nada) quando: os dois ids são iguais; um
 * dos dois não existe mais no doc; ou um contém o outro (largar um bloco em
 * cima do seu próprio descendente/ancestral corromperia a árvore).
 */
export function wrapBlocksInColumns(editor: Editor, targetBlockId: string, incomingBlockId: string): boolean {
  if (targetBlockId === incomingBlockId) return false;
  const { state } = editor;
  const target = locateBlockWrapper(state.doc, targetBlockId);
  const incoming = locateBlockWrapper(state.doc, incomingBlockId);
  if (!target || !incoming) return false;
  if (rangesOverlap(target, incoming)) return false;

  const tr = state.tr;
  // Remove `incoming` primeiro; a posição de `target` só continua válida
  // depois de passada por `tr.mapping` (mesma técnica de `commands.ts`'s
  // `handleShiftTab` para o mesmo problema: uma exclusão anterior no
  // documento desloca tudo que vem depois dela).
  tr.delete(incoming.pos, incoming.pos + incoming.node.nodeSize);
  const mappedFrom = tr.mapping.map(target.pos);
  const mappedTo = tr.mapping.map(target.pos + target.node.nodeSize);

  const wrapper = buildColumnListWrapper(state.schema, [target.node, incoming.node]);
  tr.replaceWith(mappedFrom, mappedTo, wrapper);

  // `TextSelection.near` caminha para a frente até achar uma posição de
  // texto válida - não precisa acertar a profundidade exata (mesma folga que
  // `insertBlockHere` já usa em `core/commands.ts` para pousar dentro de um
  // nó recém-criado).
  const selPos = Math.min(mappedFrom + 1, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(selPos), 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * EDT-033, caminho sem mouse: envolve o bloco sob o cursor num layout de
 * `columnCount` colunas - ele vira a primeira (a esquerda), e `columnCount -
 * 1` parágrafos vazios novos preenchem as demais, em ordem. É o comando por
 * trás dos itens "Duas colunas"/"Três colunas" do menu `/` e do atalho de
 * teclado (`column-keymap.ts`, só para duas) - existe porque "só testável
 * arrastando" não é testável em vitest. `columnCount` menor que 2 devolve
 * `false` sem tocar a transação: um "layout" de uma coluna só não é um
 * layout.
 */
export function wrapCurrentBlockInColumns(editor: Editor, columnCount = 2): boolean {
  if (columnCount < 2) return false;
  const { state } = editor;
  const depth = contentDepthOf(editor);
  if (depth === null) return false;
  const wrapperDepth = depth - 1;
  const { $from } = state.selection;
  const wrapperPos = $from.before(wrapperDepth);
  const wrapperNode = $from.node(wrapperDepth);

  const paragraphType = state.schema.nodes[NODE_NAMES.paragraph];
  const blockType = state.schema.nodes[NODE_NAMES.block];
  const extraColumns: PMNode[] = [];
  for (let i = 1; i < columnCount; i += 1) {
    const newParagraph = paragraphType.createAndFill({ id: newBlockId() });
    if (!newParagraph) return false;
    extraColumns.push(blockType.create(null, newParagraph));
  }

  const wrapper = buildColumnListWrapper(state.schema, [wrapperNode, ...extraColumns]);
  const tr = state.tr.replaceWith(wrapperPos, wrapperPos + wrapperNode.nodeSize, wrapper);
  const selPos = Math.min(wrapperPos + 1, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(selPos), 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

function clampTransfer(delta: number, leftWidth: number, rightWidth: number): number {
  if (delta > 0) return Math.min(delta, Math.max(0, rightWidth - COLUMN_MIN_WIDTH));
  if (delta < 0) return Math.max(delta, -Math.max(0, leftWidth - COLUMN_MIN_WIDTH));
  return 0;
}

/**
 * Move a fronteira entre `leftColumnBlockId` e a coluna imediatamente à
 * direita dela: soma `deltaFraction` à esquerda e subtrai da direita
 * (negativo faz o oposto), sempre respeitando `COLUMN_MIN_WIDTH` nas duas
 * pontas. É a primitiva por trás tanto do arraste na alça quanto das setas
 * do teclado (`column-node-view.ts`) - registrada aqui, não lá, pelo mesmo
 * motivo que `core/commands.ts` fica fora de `core/keymap.ts`: a cirurgia de
 * árvore testável separada da ligação com o evento de UI.
 *
 * Devolve `false` sem tocar a transação quando: a coluna não existe mais; ela
 * é a última do grupo (não há vizinha à direita); ou o delta pedido não move
 * nada depois do clamp (ex.: já está no mínimo e o usuário insiste em
 * encolher mais).
 */
export function resizeColumnBoundary(editor: Editor, leftColumnBlockId: string, deltaFraction: number): boolean {
  const { state } = editor;
  const left = locateColumnById(state.doc, leftColumnBlockId);
  if (!left) return false;

  const rightWrapper = left.context.childBlocksNode.maybeChild(left.context.index + 1);
  if (!rightWrapper) return false;
  const rightColumnNode = rightWrapper.firstChild;
  if (!rightColumnNode || rightColumnNode.type.name !== COLUMN_NODE_NAME) return false;

  // Início do wrapper à direita = fim do wrapper atual (irmãos são
  // contíguos dentro do mesmo `childBlocks`); +1 entra nele até o próprio nó
  // `column` (seu primeiro, e único, filho de conteúdo).
  const rightLeafPos = left.context.wrapperPos + left.context.wrapperNode.nodeSize + 1;
  const atRight = state.doc.nodeAt(rightLeafPos);
  if (!atRight || atRight.type.name !== COLUMN_NODE_NAME) return false;

  const leftWidth = widthOf(left.columnNode);
  const rightWidth = widthOf(rightColumnNode);
  const clamped = clampTransfer(deltaFraction, leftWidth, rightWidth);
  if (clamped === 0) return false;

  const tr = state.tr;
  tr.setNodeAttribute(left.leafPos, "width", roundWidth(leftWidth + clamped));
  tr.setNodeAttribute(rightLeafPos, "width", roundWidth(rightWidth - clamped));
  editor.view.dispatch(tr);
  return true;
}

/** Exposto para `column-node-view.ts`: sabe se há uma coluna depois desta (decide se a alça de redimensionar é desenhada) sem precisar de uma segunda busca por id - a view já tem sua própria posição via `getPos()`. */
export function hasNextColumn(doc: PMNode, leafPos: number): boolean {
  const context = wrapperContextOf(doc, leafPos);
  if (!context) return false;
  return context.index + 1 < context.childBlocksNode.childCount;
}

export { widthOf };
