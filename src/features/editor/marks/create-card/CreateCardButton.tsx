/**
 * "Criar cartão": o botão a mais na barra de seleção de texto que
 * `marks/basic/formatting-buttons.tsx` já preenche com negrito/itálico/etc.
 * Ao clicar, congela o texto realmente selecionado e o bloco que o contém —
 * o par que vira `sourceTextFrozen`/`sourceBlockId` do cartão (INT-003/
 * INT-009, `src-tauri/migrations/0011_notes_cards.sql`) — e abre
 * `CreateCardOverlay` com os dois.
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import type { ReactNode } from "react";
import { currentBlockNode } from "../../core/commands";
import { pageIdOf } from "../../core/page-context";
import "./create-card.css";
import { useCreateCardOverlayStore } from "./create-card-store";

interface CreateCardButtonProps {
  editor: TiptapEditor;
}

/** O texto realmente selecionado, sem marcas — o mesmo texto que vira o texto congelado do cartão. */
function selectedText(editor: TiptapEditor): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, "\n", "\n");
}

function CreateCardButton({ editor }: CreateCardButtonProps) {
  const hasSelection = useEditorState({
    editor,
    selector: ({ editor: current }) => !current.state.selection.empty,
  });
  const abrir = useCreateCardOverlayStore((state) => state.abrir);

  // Defesa em profundidade: o `BubbleMenu` que hospeda este botão
  // (`core/Editor.tsx`) já só aparece com seleção não vazia, mas isto
  // garante que um clique não abra um cartão vazio mesmo que a seleção
  // colapse (blur, Escape) entre o `BubbleMenu` decidir mostrar e o clique
  // chegar aqui.
  if (!hasSelection) return null;

  function handleClick() {
    const trecho = selectedText(editor).trim();
    if (!trecho) return;

    // `node.attrs` é tipado `any` pelo próprio ProseMirror (`Attrs` do
    // pacote) — não afirmamos nada sobre o valor sem checar: mesma guarda de
    // `blockGutterAnchor` em `interaction/turn-into/turn-into-handle.ts`.
    const idDoBloco: unknown = currentBlockNode(editor)?.attrs.id;
    const blocoOrigemId = typeof idDoBloco === "string" && idDoBloco.length > 0 ? idDoBloco : null;

    abrir({ trecho, blocoOrigemId, paginaOrigemId: pageIdOf(editor) });
  }

  return (
    <button
      type="button"
      aria-label="Criar cartão"
      className="ed-create-card-button"
      // Mesmo motivo de `MarkFormattingButton`: sem isto o mousedown colapsa
      // a seleção antes do `onClick` rodar, e o cartão nasceria sem trecho.
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleClick}
    >
      🗂️
    </button>
  );
}

export function renderCreateCardButton(editor: TiptapEditor): ReactNode {
  return <CreateCardButton editor={editor} />;
}
