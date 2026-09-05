/**
 * EDT-050/EDT-051: registra a alça de arrastar-blocos. Sem `BlockSpec` (não
 * é um tipo de bloco novo, não muda o que é persistido) e sem item de menu -
 * é comportamento de interação puro, exatamente a categoria que o README
 * descreve como "normalmente uma `Extension` com
 * `addProseMirrorPlugins`/`addKeyboardShortcuts` própria".
 */
import { registerBlockExtension } from "../../core/registry";
import { BlockDragHandle } from "./drag-extension";

registerBlockExtension(BlockDragHandle);
