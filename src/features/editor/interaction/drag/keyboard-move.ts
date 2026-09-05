/**
 * EDT-050 por teclado: Ctrl/Cmd+Shift+Seta-Cima/Baixo troca o bloco sob o
 * cursor de lugar com o irmão anterior/seguinte no mesmo nível - existe
 * porque só-mouse não é acessível nem testável em unidade (a geometria de
 * `drop-zone.ts` depende de um `getBoundingClientRect()` que só existe fora
 * do jsdom). Usa o mesmo `reorderBlock` que o mouse usa; a única diferença é
 * de onde vêm origem e destino - aqui, da posição do cursor via
 * `contentDepthOf` (primitiva pública de `core/commands.ts`), não de um id
 * solto pelo evento de drop.
 */
import type { Editor } from "@tiptap/core";
import { contentDepthOf } from "../../core/commands";
import { NODE_NAMES } from "../../core/node-names";
import { reorderBlock } from "./node-move";

export type MoveDirection = "up" | "down";

export function moveBlockAmongSiblings(editor: Editor, direction: MoveDirection): boolean {
  const { state } = editor;
  const contentDepth = contentDepthOf(editor);
  if (contentDepth === null) return false;

  const { $from } = state.selection;
  const ownId = $from.node(contentDepth).attrs.id;
  if (typeof ownId !== "string") return false;

  const wrapperDepth = contentDepth - 1;
  const neighbor =
    direction === "up"
      ? state.doc.resolve($from.before(wrapperDepth)).nodeBefore
      : state.doc.resolve($from.after(wrapperDepth)).nodeAfter;
  if (!neighbor || neighbor.type.name !== NODE_NAMES.block) return false;

  const neighborId = neighbor.firstChild?.attrs.id;
  if (typeof neighborId !== "string") return false;

  return reorderBlock(editor, ownId, neighborId, direction === "up" ? "before" : "after");
}
