/**
 * EDT-059: copiar E colar preservando a estrutura de blocos. Uma seleção
 * múltipla (`selection-state.ts`) não é uma `Selection` nativa do
 * ProseMirror - o `copy`/`paste` default do navegador só enxerga o que a
 * seleção de TEXTO cobre (às vezes nada, se o usuário nunca tocou num
 * cursor de texto de verdade depois de um arrasto de margem). Este módulo
 * intercepta `copy` e `paste` SÓ quando há sinal seu no clipboard - devolve
 * `false` (deixa o comportamento default, ou outro builder, tratar)
 * caso contrário.
 *
 * Dois formatos saem no `copy`: HTML (`data-block-type="..."`, lido de
 * volta pelo `parseHTML` de cada nó do `core/schema.ts` - é o que sustenta
 * colar este conteúdo num editor de texto qualquer fora do Learno) e um
 * MIME próprio (`BLOCKS_MIME`) carregando o JSON nativo de cada wrapper
 * (`Node.toJSON()`). É esse segundo formato que `handlePasteSelectedBlocks`
 * lê de volta via `Schema#nodeFromJSON` - bit-a-bit, sem depender de HTML
 * reconstruir a mesma árvore, e é o sinal que separa "isto é uma colagem
 * nossa" de qualquer outro paste (imagem em `blocks/media`, URL em
 * `blocks/bookmark`): ausência de `BLOCKS_MIME` sempre devolve `false`.
 *
 * Ids colados: nunca gerados aqui. `core/unique-ids.ts` (`appendTransaction`
 * do `UniqueBlockIds`) já troca por um id novo qualquer nó do grupo
 * `blockContent` cujo id colida com um já existente no doc, nested incluso -
 * o próprio README documenta essa garantia como já cobrindo qualquer paste,
 * não só o default do navegador.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { DOMSerializer } from "@tiptap/pm/model";
import { contentDepthOf } from "../../core/commands";
import { getSelectedBlockIds } from "./selection-state";
import { selectedWrapperNodesInOrder } from "./selection-commands";

const HTML_MIME = "text/html";
const TEXT_MIME = "text/plain";
/** MIME próprio (nunca padronizado, então segue a convenção `x-` de tipos privados de aplicação) - ver cabeçalho do módulo. Exportado pra `selection.test.ts` nunca redigitar a string à parte. */
export const BLOCKS_MIME = "application/x-learno-blocks+json";

/** O HTML de cada bloco selecionado, concatenado em ordem de documento, via o mesmo `renderHTML` que a tela usa - `null` sem seleção múltipla. */
export function serializeSelectedBlocksToHtml(editor: Editor): string | null {
  const ids = getSelectedBlockIds(editor);
  if (ids.length === 0) return null;
  const wrappers = selectedWrapperNodesInOrder(editor.state.doc, ids);
  if (wrappers.length === 0) return null;

  const serializer = DOMSerializer.fromSchema(editor.state.schema);
  const container = document.createElement("div");
  for (const wrapper of wrappers) {
    container.appendChild(serializer.serializeNode(wrapper));
  }
  return container.innerHTML;
}

/** Fallback de texto puro (aplicativos fora do editor) - um bloco por linha, via `Node.textContent`. */
export function serializeSelectedBlocksToText(editor: Editor): string | null {
  const ids = getSelectedBlockIds(editor);
  if (ids.length === 0) return null;
  const wrappers = selectedWrapperNodesInOrder(editor.state.doc, ids);
  if (wrappers.length === 0) return null;
  return wrappers.map((wrapper) => wrapper.textContent).join("\n");
}

/** O formato de round-trip de EDT-059: o JSON nativo de cada `Block` wrapper (`Node.toJSON()`), num array, na mesma ordem de documento - `null` sem seleção múltipla. `parseBlocksFromClipboard` é o lado inverso. */
export function serializeSelectedBlocksToClipboardJson(editor: Editor): string | null {
  const ids = getSelectedBlockIds(editor);
  if (ids.length === 0) return null;
  const wrappers = selectedWrapperNodesInOrder(editor.state.doc, ids);
  if (wrappers.length === 0) return null;
  return JSON.stringify(wrappers.map((wrapper) => wrapper.toJSON()));
}

export function handleCopySelectedBlocks(editor: Editor, event: ClipboardEvent): boolean {
  if (!event.clipboardData) return false;
  const html = serializeSelectedBlocksToHtml(editor);
  if (html === null) return false;

  const blocksJson = serializeSelectedBlocksToClipboardJson(editor);
  if (blocksJson !== null) event.clipboardData.setData(BLOCKS_MIME, blocksJson);
  event.clipboardData.setData(HTML_MIME, html);
  event.clipboardData.setData(TEXT_MIME, serializeSelectedBlocksToText(editor) ?? "");
  event.preventDefault();
  return true;
}

/** A mesma leitura mínima de `ClipboardEvent`/`DataTransfer` que o parse precisa - estruturalmente satisfeita pelos dois, sem cast (mesmo padrão de `ClipboardTextSource` em `blocks/bookmark/paste-plugin.ts`, redeclarado aqui pra não acoplar esta pasta à de outro builder). */
export interface ClipboardBlocksSource {
  getData(format: string): string | null;
}

/**
 * O parse de EDT-059: `null` para qualquer clipboard sem `BLOCKS_MIME`
 * (conteúdo de fora do editor, ou de outro app) ou cujo payload não
 * reconstrói contra o schema atual - o sinal que `handlePasteSelectedBlocks`
 * usa pra devolver `false` e deixar outro paste handler (imagem em
 * `blocks/media`, URL em `blocks/bookmark`) tratar o evento.
 */
export function parseBlocksFromClipboard(schema: Schema, clipboard: ClipboardBlocksSource): PMNode[] | null {
  const raw = clipboard.getData(BLOCKS_MIME);
  if (!raw) return null;

  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return null; // payload corrompido, ou outro app usando o mesmo nome de MIME por coincidência
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;

  try {
    // `Schema#nodeFromJSON` reconstrói cada wrapper (aninhamento incluso,
    // recursivamente, porque `childBlocks` já está dentro do `content` do
    // JSON) - a mesma leitura que o histórico de undo do próprio
    // ProseMirror usa, não uma reimplementação nossa.
    return entries.map((entry) => schema.nodeFromJSON(entry));
  } catch {
    return null; // JSON bem formado mas incompatível com o schema atual (ex.: clipboard de uma versão antiga do editor)
  }
}

/** Insere os wrappers colados como irmãos logo depois do bloco sob o cursor - mesma técnica de `duplicateCurrentBlock` (`selection-commands.ts`): sobe do nível de conteúdo (`contentDepth`) pro nível do wrapper (`wrapperDepth = contentDepth - 1`) e usa `$from.after` pra achar o fim do wrapper atual, então funciona em qualquer profundidade de aninhamento, não só na raiz. */
function insertParsedBlocksAfterCursor(editor: Editor, blocks: readonly PMNode[], contentDepth: number): void {
  const { state } = editor;
  const wrapperDepth = contentDepth - 1;
  const insertAt = state.selection.$from.after(wrapperDepth);
  editor.view.dispatch(state.tr.insert(insertAt, blocks).scrollIntoView());
}

/**
 * EDT-059, lado da colagem: só age quando o clipboard carrega `BLOCKS_MIME`
 * (uma cópia nossa) E o cursor está dentro de um bloco de texto - qualquer
 * outra combinação devolve `false`, deixando o paste seguir pro próximo
 * handler encadeado (README: "o primeiro que devolve `true` vence").
 */
export function handlePasteSelectedBlocks(editor: Editor, event: ClipboardEvent): boolean {
  if (!event.clipboardData) return false;
  const blocks = parseBlocksFromClipboard(editor.schema, event.clipboardData);
  if (!blocks) return false;
  const depth = contentDepthOf(editor);
  if (depth === null) return false;

  event.preventDefault();
  insertParsedBlocksAfterCursor(editor, blocks, depth);
  return true;
}
