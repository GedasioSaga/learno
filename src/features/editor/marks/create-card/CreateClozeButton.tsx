/**
 * "Criar lacuna": o segundo botão desta pasta na barra de seleção, ao lado
 * de `CreateCardButton`. O gesto central do produto — "selecionar um trecho
 * cria um card" (`HANDOFF.md`) — para o tipo de nota mais usado do Anki.
 *
 * Congela TRÊS coisas, não duas: o trecho selecionado e o bloco (como o
 * botão irmão — viram `sourceTextFrozen`/`sourceBlockId`), mais o TEXTO
 * INTEIRO do bloco com a posição do trecho dentro dele. É sobre essa cópia
 * que `CriarLacunaDeOrigem` deixa o usuário marcar mais lacunas antes de
 * salvar. Só LÊ o editor: nada aqui despacha transação, e o teste
 * `create-cloze.test.tsx` afirma que o documento sai igual ao que entrou.
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import type { ReactNode } from "react";
import type { OrigemDeLacuna } from "../../../cartoes/CriarLacunaDeOrigem";
import { contentDepthOf } from "../../core/commands";
import { pageIdOf } from "../../core/page-context";
import "./create-card.css";
import { useCreateCardOverlayStore } from "./create-card-store";

interface CreateClozeButtonProps {
  editor: TiptapEditor;
}

/**
 * O texto do bloco que contém a seleção e onde a seleção cai nele.
 * `textBetween` com `"\n"` para nó-folha e para fronteira de bloco: cada
 * posição do ProseMirror dentro de um bloco de texto vira exatamente um
 * caractere, então `from - início do bloco` é um índice de string válido.
 *
 * Seleção que atravessa blocos não tem "o bloco": cai para o próprio trecho
 * como texto inteiro — ainda vira uma lacuna válida, só sem o contexto ao
 * redor.
 */
function origemDaSelecao(editor: TiptapEditor): Pick<OrigemDeLacuna, "textoDoBloco" | "selecao" | "trecho" | "blocoOrigemId"> | null {
  const { from, to, $from, $to } = editor.state.selection;
  const trecho = editor.state.doc.textBetween(from, to, "\n", "\n").trim();
  if (!trecho) return null;

  const depth = contentDepthOf(editor);
  const mesmoBloco = depth !== null && $to.depth >= depth && $from.start(depth) === $to.start(depth);
  if (depth === null || !mesmoBloco) {
    return { textoDoBloco: trecho, selecao: { inicio: 0, fim: trecho.length }, trecho, blocoOrigemId: null };
  }

  const bloco = $from.node(depth);
  const inicioDoBloco = $from.start(depth);
  const textoDoBloco = bloco.textBetween(0, bloco.content.size, "\n", "\n");
  // Mesma guarda de `CreateCardButton`: `attrs` é `any` pelo ProseMirror.
  const idDoBloco: unknown = bloco.attrs.id;
  const blocoOrigemId = typeof idDoBloco === "string" && idDoBloco.length > 0 ? idDoBloco : null;

  return {
    textoDoBloco,
    selecao: { inicio: from - inicioDoBloco, fim: to - inicioDoBloco },
    trecho,
    blocoOrigemId,
  };
}

function CreateClozeButton({ editor }: CreateClozeButtonProps) {
  const hasSelection = useEditorState({
    editor,
    selector: ({ editor: current }) => !current.state.selection.empty,
  });
  const abrirLacuna = useCreateCardOverlayStore((state) => state.abrirLacuna);

  if (!hasSelection) return null;

  function handleClick() {
    const origem = origemDaSelecao(editor);
    if (!origem) return;
    abrirLacuna({ ...origem, paginaOrigemId: pageIdOf(editor) });
  }

  return (
    <button
      type="button"
      aria-label="Criar lacuna"
      className="ed-create-card-button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleClick}
    >
      {/* A mesma cara que a lacuna tem na tela de estudo (`TextoComLacuna`):
          linha de base âmbar e reticências. O usuário reconhece o ícone
          porque já viu o conceito. */}
      <span aria-hidden="true" className="ed-create-cloze-glyph">
        …
      </span>
    </button>
  );
}

export function renderCreateClozeButton(editor: TiptapEditor): ReactNode {
  return <CreateClozeButton editor={editor} />;
}
