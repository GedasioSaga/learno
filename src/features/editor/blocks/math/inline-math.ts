/**
 * EDT-023: equação inline. `group: "inline"` é o que a faz válida em
 * qualquer bloco de texto (`content: "inline*"`) sem precisar listar cada
 * tipo - ver README, "Marcas de texto ... ganham de graça". Não tem
 * `BlockSpec` (confirmado lendo `serialize.ts`: `nodeContentFor` default
 * devolve `content.inline` inteiro, JSONContent bruto, então um nó custom
 * dentro dele - inclusive este - sobrevive ao round trip sem entrada
 * própria no registro).
 *
 * Dois jeitos de criar uma (EDT-023): fechar `$..$` (input rule) ou
 * Ctrl/Cmd+Shift+E, que embrulha a seleção atual (ou abre vazia, em edição,
 * se não houver seleção).
 */
import type { Editor } from "@tiptap/core";
import { mergeAttributes, Node, nodeInputRule } from "@tiptap/core";
import { createMathNodeView, type RenderLatex } from "./math-node-view";
import { INLINE_MATH_NODE_NAME } from "./node-names";
import { renderLatexNode } from "./render-latex";

/** `$expr$`: sem `$` nem quebra de linha dentro, fechado pelo `$` que acabou de ser digitado. */
const INLINE_MATH_DELIMITER = /\$([^$\n]+)\$$/;

function expressionOf(attrs: Record<string, unknown>): string {
  return typeof attrs.expression === "string" ? attrs.expression : "";
}

function insertInlineMathAtSelection(editor: Editor): boolean {
  const { state } = editor;
  const type = state.schema.nodes[INLINE_MATH_NODE_NAME];
  if (!type) return false;
  const { selection } = state;
  const expression = selection.empty ? "" : state.doc.textBetween(selection.from, selection.to, "");
  const node = type.create({ expression });
  const tr = state.tr.replaceSelectionWith(node, false);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Fábrica pelo mesmo motivo de `createEquationExtension` - ver ali. */
export function createInlineMathExtension(renderLatex: RenderLatex = renderLatexNode) {
  return Node.create({
    name: INLINE_MATH_NODE_NAME,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes() {
      return { expression: { default: "" } };
    },
    parseHTML() {
      return [{ tag: `span[data-inline-type="${INLINE_MATH_NODE_NAME}"]` }];
    },
    renderHTML({ HTMLAttributes, node }) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, {
          "data-inline-type": INLINE_MATH_NODE_NAME,
          class: "ed-inline-math",
          "data-expression": expressionOf(node.attrs),
          contenteditable: "false",
        }),
      ];
    },
    addInputRules() {
      return [
        nodeInputRule({
          find: INLINE_MATH_DELIMITER,
          type: this.type,
          getAttributes: (match) => ({ expression: match[1] }),
        }),
      ];
    },
    addKeyboardShortcuts() {
      return {
        "Mod-Shift-e": ({ editor }) => insertInlineMathAtSelection(editor),
      };
    },
    addNodeView() {
      return createMathNodeView(renderLatex, { display: false, editTag: "input", blockClass: "ed-inline-math" });
    },
  });
}

export const InlineMath = createInlineMathExtension();
