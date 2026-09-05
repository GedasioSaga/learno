/**
 * Ponto de junção: liga o estado (`selection-state.ts`), os comandos
 * (`selection-commands.ts`), o mouse (`selection-mouse.ts`) e o clipboard
 * (`selection-clipboard.ts`) num único `Extension` do TipTap.
 *
 * Ordem de plugin importa pros atalhos de teclado. `ExtensionManager.plugins`
 * (`@tiptap/core`) monta a lista de plugins de teclado na ordem INVERSA de
 * `this.extensions` - e `this.extensions` é
 * `[...coreExtensions, ...StarterKit, ...structuralNodes, UniqueBlockIds,
 * BlockKeymap, ...collectRegisteredExtensions()]` (`core/extensions.ts`).
 * Invertida, um builder registrado por `discover-extensions.ts` (como este)
 * fica ANTES de `BlockKeymap` e ANTES da extensão `Keymap` que todo `Editor`
 * carrega por padrão (a que liga `Mod-a` -> `selectAll` do documento
 * inteiro). ProseMirror processa `handleKeyDown` nessa ordem e para no
 * primeiro que devolve `true` - por isso:
 *   - `Mod-a` daqui vence o `Mod-a` default (EDT-055 nunca deixa passar pro
 *     `selectAll` do core).
 *   - `Backspace` daqui roda ANTES do `handleBackspace` estrutural
 *     (`core/commands.ts`) - por isso ele tem que devolver `false` sem
 *     seleção múltipla ativa, senão rouba o Backspace de cursor simples que
 *     o core já cobre (EDT-069/070).
 * Verificado lendo `node_modules/@tiptap/core/dist/index.js` (`get
 * plugins()`/`createExtensionManager()`), não só suposto - `selection.test.ts`
 * prova as duas pontas (intercepta com seleção múltipla, deixa passar sem).
 */
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { handleCopySelectedBlocks, handlePasteSelectedBlocks } from "./selection-clipboard";
import { deleteSelectedBlocks, duplicateSelectedBlocks, selectBlockText } from "./selection-commands";
import { createSelectionMouseHandlers } from "./selection-mouse";
import { BlockSelectionStatePlugin, getSelectedBlockIds } from "./selection-state";

export const BlockSelectionExtension = Extension.create({
  name: "blockSelection",

  addKeyboardShortcuts() {
    const editor = this.editor;
    return {
      "Mod-a": () => selectBlockText(editor),
      "Mod-d": () => duplicateSelectedBlocks(editor),
      Backspace: () => {
        if (getSelectedBlockIds(editor).length === 0) return false;
        return deleteSelectedBlocks(editor);
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const mouse = createSelectionMouseHandlers(editor);

    return [
      BlockSelectionStatePlugin,
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown: mouse.mousedown,
            copy: (_view, event) => handleCopySelectedBlocks(editor, event),
          },
          handlePaste: (_view, event) => handlePasteSelectedBlocks(editor, event),
        },
        // Um arrasto de margem escuta `window` (o ponteiro sai de
        // `view.dom` durante o arrasto) - `view.destroy` do próprio
        // ProseMirror é quem garante que esses listeners somem quando o
        // editor desmonta (troca de página), sem depender de nenhum hook
        // do lado do TipTap.
        view: () => ({ destroy: () => mouse.destroy() }),
      }),
    ];
  },
});
