/**
 * Ações que operam sobre a seleção múltipla de `selection-state.ts`, mais o
 * primitivo de EDT-055 (que não depende dela - age no bloco do cursor).
 * Tudo puro/orientado a `Editor`, no mesmo espírito de `core/commands.ts`:
 * cada função devolve se tratou a tecla, para o atalho correspondente
 * (`selection-extension.ts`) só encaminhar.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { contentDepthOf } from "../../core/commands";
import { newBlockId } from "../../core/ids";
import { NODE_NAMES } from "../../core/node-names";
import { blockSelectionPluginKey, EMPTY_BLOCK_SELECTION, getSelectedBlockIds, type BlockSelectionState } from "./selection-state";

/**
 * EDT-055: Ctrl/Cmd+A no bloco - primeiro nível só (o critério pede
 * explicitamente "uma vez"; escalar pro documento inteiro numa segunda
 * pressionada é EDT-056, fora deste checklist). Seleciona só o range de
 * texto do `blockContent` sob o cursor, então os vizinhos nunca são
 * afetados - ao contrário do `Mod-a` default do TipTap (`selectAll`, ligado
 * pela extensão `Keymap` que todo `Editor` carrega), que seleciona o
 * documento inteiro de uma vez. Este atalho tem que vencer aquele - ver
 * `selection-extension.ts`'s comentário sobre ordem de plugin.
 */
export function selectBlockText(editor: Editor): boolean {
  const depth = contentDepthOf(editor);
  if (depth === null) return false;
  const { state } = editor;
  const { $from } = state.selection;
  const from = $from.start(depth);
  const to = $from.end(depth);
  editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  return true;
}

/**
 * Todo `Block` wrapper (`core/schema.ts`) cujo próprio id está em `ids`,
 * achado uma vez só - ao encontrar um, `descendants` não desce nos filhos
 * dele (`return false`), então um bloco aninhado cujo pai também esteja
 * selecionado nunca aparece duas vezes nem é processado separadamente.
 */
function selectedWrappers(doc: PMNode, ids: ReadonlySet<string>): Array<{ pos: number; node: PMNode }> {
  const found: Array<{ pos: number; node: PMNode }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== NODE_NAMES.block) return true;
    const id = node.firstChild?.attrs.id;
    if (typeof id === "string" && ids.has(id)) {
      found.push({ pos, node });
      return false;
    }
    return true;
  });
  return found;
}

/** Mesmos wrappers de `selectedWrappers`, só os nós, em ordem de documento - o que a serialização de clipboard (EDT-059) precisa. */
export function selectedWrapperNodesInOrder(doc: PMNode, ids: readonly string[]): PMNode[] {
  return selectedWrappers(doc, new Set(ids))
    .sort((a, b) => a.pos - b.pos)
    .map(({ node }) => node);
}

/** Ids diretos de um nó de conteúdo "block+" (o `doc`, ou um `childBlocks`) - cada um lido do primeiro filho do seu próprio wrapper, exatamente como `serialize.ts` faz. */
function directBlockIds(parent: PMNode): string[] {
  const ids: string[] = [];
  parent.forEach((wrapper) => {
    const id = wrapper.firstChild?.attrs.id;
    if (typeof id === "string") ids.push(id);
  });
  return ids;
}

/**
 * EDT-054: os ids entre `anchorId` e `targetId`, inclusive, no MESMO nível
 * de aninhamento - o nível em que os dois aparecem como irmãos diretos (o
 * `doc` em si, ou algum `childBlocks`). `null` quando os dois não
 * compartilham um nível (um deles não existe, ou um é ancestral do outro) -
 * quem chama decide o que fazer nesse caso (não estende a seleção).
 */
export function siblingIdsBetween(doc: PMNode, anchorId: string, targetId: string): string[] | null {
  function rangeWithin(parent: PMNode): string[] | null {
    const ids = directBlockIds(parent);
    const anchorIndex = ids.indexOf(anchorId);
    const targetIndex = ids.indexOf(targetId);
    if (anchorIndex === -1 || targetIndex === -1) return null;
    const [from, to] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    return ids.slice(from, to + 1);
  }

  const atRoot = rangeWithin(doc);
  if (atRoot) return atRoot;

  let result: string[] | null = null;
  doc.descendants((node) => {
    if (result) return false;
    if (node.type.name === NODE_NAMES.childBlocks) result = rangeWithin(node);
    return true;
  });
  return result;
}

/** Mapa id -> id do bloco pai direto, ou `null` no nível raiz - achatado do doc inteiro numa única passada recursiva. `doc` em si e cada `childBlocks` são o mesmo tipo de "container de irmãos" que `directBlockIds` já lê. */
function parentIdByBlockId(doc: PMNode): Map<string, string | null> {
  const parentOf = new Map<string, string | null>();
  function walk(container: PMNode, parentId: string | null): void {
    container.forEach((wrapper) => {
      const id = wrapper.firstChild?.attrs.id;
      if (typeof id !== "string") return;
      parentOf.set(id, parentId);
      const childBlocks = wrapper.childCount === 2 ? wrapper.lastChild : null;
      if (childBlocks) walk(childBlocks, id);
    });
  }
  walk(doc, null);
  return parentOf;
}

/** Quantos níveis de aninhamento até a raiz - 0 para um bloco raiz. */
function depthOfBlock(parentOf: ReadonlyMap<string, string | null>, id: string): number {
  let depth = 0;
  let current = parentOf.get(id) ?? null;
  while (current !== null) {
    depth += 1;
    current = parentOf.get(current) ?? null;
  }
  return depth;
}

/** Sobe `id` pela cadeia de pais até `targetDepth` (que deve ser <= `fromDepth`, a profundidade atual de `id`). */
function climbToDepth(parentOf: ReadonlyMap<string, string | null>, id: string, fromDepth: number, targetDepth: number): string {
  let current = id;
  let depth = fromDepth;
  while (depth > targetDepth) {
    const parent = parentOf.get(current);
    if (parent === null || parent === undefined) break; // defensivo: não deveria disparar se `fromDepth` veio de `depthOfBlock`
    current = parent;
    depth -= 1;
  }
  return current;
}

/**
 * EDT-053/054: a versão de `siblingIdsBetween` que um gesto de mouse de
 * verdade precisa. Arrasto de margem e Shift+clique não garantem que âncora
 * e alvo estejam no mesmo nível de aninhamento - arrastar da margem de um
 * bloco raiz até dentro de um toggle de outro bloco raiz é o caso comum, e
 * `siblingIdsBetween` sozinho devolveria `null` ali, travando a seleção
 * exatamente no meio do arrasto.
 *
 * Normaliza os dois ids pro nível comum mais raso antes de delegar pra
 * `siblingIdsBetween`: sobe o mais fundo dos dois até igualar profundidades,
 * depois sobe os dois JUNTOS até compartilharem o mesmo pai. Sempre termina
 * - todo bloco tem uma cadeia de pais que acaba em `null` (nível raiz), e
 * todo bloco raiz compartilha esse mesmo pai `null`, então o pior caso é
 * "os dois viram blocos raiz" (nunca um terceiro `null` sem match).
 *
 * Cobre o gesto invertido (de baixo pra cima) de graça - `siblingIdsBetween`
 * já ordena o range pela posição no documento, não pela ordem de chegada
 * de âncora/alvo.
 */
export function resolveSelectionRangeIds(doc: PMNode, startId: string, currentId: string): string[] | null {
  const parentOf = parentIdByBlockId(doc);
  if (!parentOf.has(startId) || !parentOf.has(currentId)) return null;

  const startDepth = depthOfBlock(parentOf, startId);
  const currentDepth = depthOfBlock(parentOf, currentId);
  let start = startDepth > currentDepth ? climbToDepth(parentOf, startId, startDepth, currentDepth) : startId;
  let current = currentDepth > startDepth ? climbToDepth(parentOf, currentId, currentDepth, startDepth) : currentId;

  while ((parentOf.get(start) ?? null) !== (parentOf.get(current) ?? null)) {
    // Não deveria cair no fallback `?? start`/`?? current`: as profundidades
    // seguem iguais a cada passo (os dois sobem juntos), então os dois
    // batem em `null` na mesma iteração, o mais tardar no nível raiz.
    start = parentOf.get(start) ?? start;
    current = parentOf.get(current) ?? current;
  }

  return siblingIdsBetween(doc, start, current);
}

/** O `doc` inteiro (nível raiz) só tem blocos que estão em `ids` - ver `deleteSelectedBlocks`. */
function wholeDocumentIsSelected(doc: PMNode, ids: ReadonlySet<string>): boolean {
  if (doc.childCount === 0) return false;
  let complete = true;
  doc.forEach((wrapper) => {
    const id = wrapper.firstChild?.attrs.id;
    if (typeof id !== "string" || !ids.has(id)) complete = false;
  });
  return complete;
}

/**
 * EDT-057: Backspace com seleção múltipla apaga os blocos inteiros numa
 * única transação - um só Ctrl/Cmd+Z desfaz tudo, porque o histórico do
 * ProseMirror agrupa por transação, não por bloco. Devolve `false` sem
 * seleção múltipla ativa: o cursor simples continua com `handleBackspace`
 * do core (`core/commands.ts`, encaminhado por `core/keymap.ts`) - ver o
 * comentário de ordem de plugin em `selection-extension.ts` sobre por que
 * isso não rouba o Backspace comum.
 */
export function deleteSelectedBlocks(editor: Editor): boolean {
  const ids = getSelectedBlockIds(editor);
  if (ids.length === 0) return false;
  const { state } = editor;
  const idSet = new Set(ids);
  const wrappers = selectedWrappers(state.doc, idSet);
  if (wrappers.length === 0) return false;

  const tr = state.tr;

  if (wholeDocumentIsSelected(state.doc, idSet)) {
    // `doc` exige pelo menos um `Block` wrapper ("block+", core/schema.ts) -
    // apagar todos os blocos existentes deixaria zero. ProseMirror não
    // recusa isso: `Transform.delete` silenciosamente preenche com um
    // parágrafo em branco pra manter o doc válido (o mesmo comportamento que
    // `core/commands.ts`'s `handleShiftTab` documenta pro `childBlocks`, que
    // tem o mesmo "block+"), mas esse parágrafo nasce sem `id` (o atributo
    // não tem como ganhar um valor default dinâmico - `core/schema.ts`) e
    // `docToFlatBlocks` (`core/serialize.ts`) ignora silenciosamente todo
    // nó sem `id` string: o resultado seria uma página que parece ter um
    // parágrafo vazio na tela mas persiste zero blocos. Substituir
    // explicitamente por um parágrafo com um id de verdade evita depender
    // desse preenchimento implícito.
    const paragraph = state.schema.nodes[NODE_NAMES.paragraph].createAndFill({ id: newBlockId() });
    const wrapperType = state.schema.nodes[NODE_NAMES.block];
    if (paragraph) tr.replaceWith(0, state.doc.content.size, wrapperType.create(null, paragraph));
  } else {
    // Do maior `pos` pro menor: apagar um range mais à frente nunca desloca
    // a posição, ainda válida no doc original, de um range mais atrás.
    const sorted = [...wrappers].sort((a, b) => b.pos - a.pos);
    for (const { pos, node } of sorted) tr.delete(pos, pos + node.nodeSize);
  }

  tr.setMeta(blockSelectionPluginKey, EMPTY_BLOCK_SELECTION);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Clona um `Block` wrapper inteiro com ids novos - o dele e o de cada filho
 * aninhado. Reaproveitar um id existente corromperia o banco (dois blocos
 * disputando a mesma linha) - o README avisa disso especificamente para
 * este item (EDT-058).
 */
function cloneWrapperWithFreshIds(schema: Schema, wrapper: PMNode): PMNode {
  const contentNode = wrapper.firstChild;
  if (!contentNode) return wrapper.copy(wrapper.content); // defensivo: um wrapper bem formado sempre tem esse filho

  const clonedContent = contentNode.type.create(
    { ...contentNode.attrs, id: newBlockId() },
    contentNode.content,
    contentNode.marks,
  );

  const childBlocksNode = wrapper.childCount === 2 ? wrapper.lastChild : null;
  const clonedChildren: PMNode[] = [];
  childBlocksNode?.forEach((childWrapper) => clonedChildren.push(cloneWrapperWithFreshIds(schema, childWrapper)));

  const wrapperChildren: PMNode[] = [clonedContent];
  if (clonedChildren.length > 0) {
    wrapperChildren.push(schema.nodes[NODE_NAMES.childBlocks].create(null, clonedChildren));
  }
  return schema.nodes[NODE_NAMES.block].create(null, wrapperChildren);
}

function duplicateCurrentBlock(editor: Editor): boolean {
  const depth = contentDepthOf(editor);
  if (depth === null) return false;
  const { state } = editor;
  const wrapperDepth = depth - 1;
  const { $from } = state.selection;
  const wrapper = $from.node(wrapperDepth);
  const insertAt = $from.after(wrapperDepth);
  const clone = cloneWrapperWithFreshIds(state.schema, wrapper);
  editor.view.dispatch(state.tr.insert(insertAt, clone).scrollIntoView());
  return true;
}

/** Duplica a seleção múltipla inteira, como um grupo, logo depois do último bloco selecionado - preserva a ordem relativa entre eles. */
function duplicateMultipleBlocks(editor: Editor, ids: readonly string[]): boolean {
  const { state } = editor;
  const ordered = selectedWrappers(state.doc, new Set(ids)).sort((a, b) => a.pos - b.pos);
  if (ordered.length === 0) return false;

  const last = ordered[ordered.length - 1];
  const insertAt = last.pos + last.node.nodeSize;
  const clones = ordered.map(({ node }) => cloneWrapperWithFreshIds(state.schema, node));

  const tr = state.tr.insert(insertAt, clones);
  const newIds = clones
    .map((clone) => clone.firstChild?.attrs.id)
    .filter((id): id is string => typeof id === "string");
  tr.setMeta(blockSelectionPluginKey, { ids: newIds } satisfies BlockSelectionState);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** EDT-058: Ctrl/Cmd+D duplica o bloco do cursor, ou a seleção múltipla inteira quando há uma - sempre com ids novos (nunca reaproveitados). */
export function duplicateSelectedBlocks(editor: Editor): boolean {
  const ids = getSelectedBlockIds(editor);
  if (ids.length > 0) return duplicateMultipleBlocks(editor, ids);
  return duplicateCurrentBlock(editor);
}
