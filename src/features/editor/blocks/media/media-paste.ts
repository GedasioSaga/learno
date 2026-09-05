/**
 * EDT-061: colar uma imagem do clipboard num bloco vazio a transforma em
 * bloco de imagem, sem etapa manual de upload. Um `Extension` com
 * `addProseMirrorPlugins`/`props.handlePaste` próprio, como o README pede -
 * vários plugins encadeiam naturalmente (o primeiro que devolve `true`
 * vence), então isto nunca precisa saber se outro builder também trata
 * colar.
 *
 * Só intercepta quando o bloco sob o cursor está vazio, de propósito: é
 * exatamente o que o critério descreve ("num bloco vazio"), e colar uma
 * imagem em cima de texto existente não deveria apagar esse texto sem um
 * sinal mais explícito do usuário.
 */
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { contentDepthOf, currentBlockNode } from "../../core/commands";
import { IMAGE_KIND, insertMediaFromFile } from "./media-upload";

function firstImageFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of data.files) {
    if (item.type.startsWith("image/")) return item;
  }
  return null;
}

export const MediaPaste = Extension.create({
  name: "mediaPaste",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const file = firstImageFile(event.clipboardData);
            if (!file) return false;
            if (contentDepthOf(editor) === null) return false;
            const block = currentBlockNode(editor);
            if (block && block.content.size > 0) return false;

            event.preventDefault();
            void insertMediaFromFile(editor, IMAGE_KIND, file);
            return true;
          },
        },
      }),
    ];
  },
});
