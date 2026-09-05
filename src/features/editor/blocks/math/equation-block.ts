/**
 * EDT-022: equação em bloco. Átomo (`hasContent: false`, `content: ""`) no
 * grupo `"blockContent"` - nunca `"block"` (ver README: um nó no grupo
 * errado apareceria solto sob `doc` e `docToFlatBlocks` o ignoraria em
 * silêncio). A expressão crua mora só em `attrs.expression`; quem decide o
 * que aparece na tela (LaTeX cru em edição, MathJax renderizado depois) é o
 * `MathNodeView` compartilhado com a equação inline - ver `math-node-view.ts`.
 */
import { mergeAttributes, Node } from "@tiptap/core";
import { createMathNodeView, type RenderLatex } from "./math-node-view";
import { EQUATION_NODE_NAME } from "./node-names";
import { renderLatexNode } from "./render-latex";

/** Mesmo padrão do `idAttribute` de `core/schema.ts` (não importável dali - é privado ao módulo) - reflete `data-block-id` para CSS/depuração. */
const idAttribute = {
  id: {
    default: null as string | null, // widening de um literal `null` pra `string | null` - sem isso TS infere só `null` e rejeita o `newBlockId()` atribuído depois; mesmo padrão do `idAttribute` de core/schema.ts.
    parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.id ? { "data-block-id": attributes.id } : {},
  },
};

function expressionOf(attrs: Record<string, unknown>): string {
  return typeof attrs.expression === "string" ? attrs.expression : "";
}

/**
 * Fábrica em vez de uma extensão pronta: `register.ts` chama esta função sem
 * argumento (usa `renderLatexNode`, a MathJax de verdade); o teste chama com
 * um `renderLatex` stub, porque MathJax não carrega a tempo sob jsdom.
 */
export function createEquationExtension(renderLatex: RenderLatex = renderLatexNode) {
  return Node.create({
    name: EQUATION_NODE_NAME,
    group: "blockContent",
    atom: true,
    selectable: true,
    content: "",
    addAttributes() {
      return { ...idAttribute, expression: { default: "" } };
    },
    parseHTML() {
      return [{ tag: `div[data-block-type="${EQUATION_NODE_NAME}"]` }];
    },
    renderHTML({ HTMLAttributes, node }) {
      return [
        "div",
        mergeAttributes(HTMLAttributes, {
          "data-block-type": EQUATION_NODE_NAME,
          class: "ed-block ed-equation",
          "data-expression": expressionOf(node.attrs),
          contenteditable: "false",
        }),
      ];
    },
    addNodeView() {
      return createMathNodeView(renderLatex, { display: true, editTag: "textarea", blockClass: "ed-equation" });
    },
  });
}

export const Equation = createEquationExtension();
