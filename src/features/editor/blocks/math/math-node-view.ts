/**
 * O NodeView que a equação em bloco (EDT-022) e a equação inline (EDT-023)
 * compartilham - as duas são "LaTeX cru quando em edição, MathJax renderizado
 * quando não": só muda a tag do campo de edição (textarea multi-linha para o
 * bloco, input de uma linha para o inline) e se `display` é `true` (SVG
 * centralizado) ou `false` (SVG no meio do texto). Vanilla `NodeView`
 * (mesmo padrão de `core/node-views.ts`), não `ReactNodeViewRenderer`: o
 * estado é só "editando ou não" mais o conteúdo dos dois `<div>`/`<span>`
 * filhos, nada que precise de uma árvore React própria.
 *
 * `renderLatex` chega por parâmetro (não importado direto de
 * `render-latex.ts`) - é o ponto que o teste substitui por um stub, porque
 * MathJax não termina de carregar a tempo sob jsdom.
 */
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView, ViewMutationRecord } from "@tiptap/pm/view";

export type RenderLatex = (expression: string, display: boolean) => Promise<Node>;

/**
 * `this.editField` é `HTMLInputElement | HTMLTextAreaElement` - TypeScript
 * não distribui a sobrecarga genérica de `addEventListener` sobre um tipo
 * união do jeito que distribui `document.createElement`, e cai na
 * assinatura genérica de `EventTarget` (`ev: Event`, sem `.key`). Um
 * parâmetro `HTMLElement` sozinho (não união) escolhe a sobrecarga certa de
 * `"keydown"` -> `KeyboardEvent`; ambos os elementos concretos são
 * `HTMLElement` de qualquer forma, então a chamada continua correta.
 */
function onKeydown(target: HTMLElement, handler: (event: KeyboardEvent) => void): void {
  target.addEventListener("keydown", handler);
}

export interface MathNodeViewOptions {
  /** `true` para a equação em bloco (centralizada), `false` para a inline. */
  display: boolean;
  editTag: "input" | "textarea";
  /** Classe raiz - as classes dos dois filhos são `${blockClass}__render` e `${blockClass}__input`. */
  blockClass: string;
  renderLatex: RenderLatex;
}

class MathNodeView implements NodeView {
  dom: HTMLElement;
  private readonly renderContainer: HTMLElement;
  private readonly editField: HTMLInputElement | HTMLTextAreaElement;
  private node: PMNode;
  private readonly editor: NodeViewRendererProps["editor"];
  private readonly getPos: NodeViewRendererProps["getPos"];
  private readonly options: MathNodeViewOptions;
  private editing: boolean;
  /** Descarta o resultado de um render que ficou pendente quando um outro, mais novo, já foi pedido. */
  private renderToken = 0;

  constructor(props: NodeViewRendererProps, options: MathNodeViewOptions) {
    this.node = props.node;
    this.editor = props.editor;
    this.getPos = props.getPos;
    this.options = options;
    this.editing = this.currentExpression().length === 0;

    const wrapperTag = options.display ? "div" : "span";
    this.dom = document.createElement(wrapperTag);
    this.dom.className = options.blockClass;
    // `addNodeView` substitui `renderHTML` inteiramente para este nó (é o
    // próprio `dom` daqui que ProseMirror monta) - os mesmos data-attrs que
    // `renderHTML` declara para cópia/colagem precisam existir aqui também,
    // para que CSS e consultas por seletor (`[data-block-type="equation"]`)
    // encontrem o mesmo nó em qualquer um dos dois caminhos.
    this.dom.setAttribute(options.display ? "data-block-type" : "data-inline-type", this.node.type.name);
    if (typeof this.node.attrs.id === "string") this.dom.setAttribute("data-block-id", this.node.attrs.id);

    this.renderContainer = document.createElement(wrapperTag);
    this.renderContainer.className = `${options.blockClass}__render`;
    this.renderContainer.setAttribute("role", "button");
    this.renderContainer.tabIndex = 0;
    this.renderContainer.setAttribute("aria-label", "Editar equação");
    this.renderContainer.addEventListener("click", () => this.enterEditMode());
    this.renderContainer.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.enterEditMode();
    });

    this.editField = document.createElement(options.editTag);
    this.editField.className = `${options.blockClass}__input`;
    this.editField.setAttribute(
      "aria-label",
      options.display ? "Código LaTeX da equação" : "Código LaTeX da equação inline",
    );
    onKeydown(this.editField, (event) => {
      // Nunca deixa o keymap estrutural do editor (Backspace, Enter...)
      // tratar teclas digitadas dentro do campo de LaTeX - ver `stopEvent`.
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.commit();
      } else if (!options.display && event.key === "Enter") {
        // A equação inline é de uma linha só; Enter nela confirma como Esc.
        event.preventDefault();
        this.commit();
      }
    });
    this.editField.addEventListener("blur", () => this.commit());

    this.dom.append(this.renderContainer, this.editField);
    this.syncMode();
    if (!this.editing) void this.renderMath(this.currentExpression());
  }

  /** Impede que ProseMirror trate eventos originados no campo de edição (o `contentDOM` não existe aqui - o nó é átomo). */
  stopEvent(event: Event): boolean {
    return event.target === this.editField || event.target === this.renderContainer;
  }

  /** As mutações no `renderContainer` são só o resultado de `renderMath` reescrevendo seu próprio conteúdo - nada que ProseMirror precise reconciliar com o doc. */
  ignoreMutation(_mutation: ViewMutationRecord): boolean {
    return true;
  }

  update(node: PMNode): boolean {
    if (node.type.name !== this.node.type.name) return false;
    this.node = node;
    if (!this.editing) void this.renderMath(this.currentExpression());
    return true;
  }

  private currentExpression(): string {
    return typeof this.node.attrs.expression === "string" ? this.node.attrs.expression : "";
  }

  private enterEditMode(): void {
    if (this.editing) return;
    this.editing = true;
    this.syncMode();
  }

  /** Grava a expressão editada (se mudou) e sai do modo de edição - EDT-022/023: "ao sair do modo de edição"/Esc. */
  private commit(): void {
    const value = this.editField.value;
    this.editing = false;
    this.syncMode();
    if (value === this.currentExpression()) {
      void this.renderMath(value);
      return;
    }
    const pos = this.getPos();
    if (pos === undefined) {
      void this.renderMath(value);
      return;
    }
    // `setNodeAttribute` despacha e chama `update()` de volta de forma
    // síncrona com o nó já atualizado - é `update()` quem renderiza daqui
    // pra frente, não esta função (evita pedir o render duas vezes).
    this.editor.view.dispatch(this.editor.state.tr.setNodeAttribute(pos, "expression", value));
  }

  private syncMode(): void {
    this.dom.setAttribute("data-latex-editing", String(this.editing));
    if (this.editing) {
      this.editField.value = this.currentExpression();
      this.editField.focus();
      this.editField.select();
    }
  }

  private async renderMath(expression: string): Promise<void> {
    const trimmed = expression.trim();
    const requestId = (this.renderToken += 1);
    if (trimmed.length === 0) {
      this.renderContainer.textContent = this.options.display ? "Equação vazia" : "";
      return;
    }
    try {
      const rendered = await this.options.renderLatex(trimmed, this.options.display);
      if (requestId !== this.renderToken) return; // uma edição mais nova já pediu outro render
      this.renderContainer.replaceChildren(rendered);
    } catch {
      if (requestId !== this.renderToken) return;
      this.renderContainer.textContent = "Não foi possível renderizar esta equação";
    }
  }
}

export function createMathNodeView(
  renderLatex: RenderLatex,
  options: Omit<MathNodeViewOptions, "renderLatex">,
): (props: NodeViewRendererProps) => NodeView {
  return (props) => new MathNodeView(props, { ...options, renderLatex });
}
