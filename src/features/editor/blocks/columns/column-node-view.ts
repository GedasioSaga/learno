/**
 * `column` é um nó "leaf" (`content: ""` - ver `column-nodes.ts`): não tem
 * onde pendurar a própria largura visualmente, porque quem precisa ficar com
 * `flex-basis: <largura>%` é o elemento flex - o `Block` wrapper (a div
 * genérica que `core/schema.ts` renderiza para TODO bloco, `.ed-block-wrapper`)
 * que é avô, não filho, do que este nó controla. `renderHTML`/CSS puro não
 * alcançam um ancestral; só JavaScript imperativo dentro de um NodeView
 * alcança. Por isso este NodeView, ao contrário de `todoItemNodeView`/
 * `toggleNodeView` em `core/node-views.ts` (que só mexem no próprio `dom`),
 * também escreve em `dom.parentElement` - o `.ed-block-wrapper` que o
 * envolve. É leitura+escrita de um atributo de estilo isolado (nunca troca
 * filhos nem remove nós), então não compete com a reconciliação de DOM que o
 * ProseMirror já faz para esse wrapper (ele não tem NodeView próprio, então
 * usa o `renderHTML` default - que nunca escreve `style` nele, só `class`).
 *
 * `queueMicrotask` (não `requestAnimationFrame`, que o ambiente de teste não
 * garante) adia a primeira sincronização até depois de o ProseMirror terminar
 * de montar a árvore de DOM da atualização atual - só nesse ponto
 * `dom.parentElement` está de fato preenchido; no instante em que o
 * construtor roda, o nó ainda pode não ter sido inserido no pai.
 */
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { COLUMN_MIN_WIDTH, COLUMN_NODE_NAME, COLUMN_RESIZE_STEP } from "./node-names";
import { hasNextColumn, resizeColumnBoundary, widthOf } from "./column-commands";

class ColumnNodeView implements NodeView {
  dom: HTMLElement;
  private node: PMNode;
  private readonly editor: NodeViewRendererProps["editor"];
  private readonly getPos: NodeViewRendererProps["getPos"];
  private readonly handle: HTMLButtonElement;

  constructor({ node, editor, getPos }: NodeViewRendererProps) {
    this.node = node;
    this.editor = editor;
    this.getPos = getPos;

    this.dom = document.createElement("div");
    this.dom.className = "ed-block ed-column";
    this.dom.setAttribute("data-block-type", COLUMN_NODE_NAME);
    this.dom.setAttribute("contenteditable", "false");
    if (typeof node.attrs.id === "string") this.dom.setAttribute("data-block-id", node.attrs.id);

    // A alça sempre existe no DOM - só sua visibilidade depende de "existe
    // uma coluna à direita", e isso só pode ser decidido com `getPos()`
    // (posição desta instância no doc), que o ProseMirror ainda não garante
    // válida dentro do próprio construtor (o node ainda pode não estar
    // inserido no pai) - por isso a checagem some para `queueMicrotask`
    // junto da largura, em vez de decidir aqui se a alça é criada.
    this.handle = this.buildHandle();
    this.dom.appendChild(this.handle);

    queueMicrotask(() => {
      this.syncHandleVisibility();
      this.syncWrapperWidth();
    });
  }

  private hasSiblingToTheRight(): boolean {
    const pos = this.getPos();
    if (pos === undefined) return false;
    return hasNextColumn(this.editor.state.doc, pos);
  }

  private syncHandleVisibility(): void {
    this.handle.hidden = !this.hasSiblingToTheRight();
  }

  private buildHandle(): HTMLButtonElement {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "ed-column-resize-handle";
    // EDT-033: "alça acessível por teclado" - `role="separator"` é o papel
    // ARIA correto para uma fronteira ajustável entre dois painéis (não
    // "slider": não há um valor único, são duas larguras que se compensam).
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.tabIndex = 0;
    this.syncHandleLabel(handle);

    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.resize(event.key === "ArrowRight" ? COLUMN_RESIZE_STEP : -COLUMN_RESIZE_STEP);
    });

    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation(); // não deixa o clique virar uma NodeSelection na coluna (ela é `atom`-adjacente via `column-nodes.ts`'s content vazio, mas o wrapper ainda reage a clique).
      const container = this.dom.parentElement?.parentElement; // `.ed-children` que enfileira as colunas - a régua para converter px em fração.
      const containerWidth = container?.getBoundingClientRect().width ?? 0;
      if (containerWidth <= 0) return;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom e alguns navegadores antigos não implementam setPointerCapture - arrastar sem captura ainda funciona, só perde o "segurar fora do elemento". */
      }
      let lastX = event.clientX;
      const onMove = (moveEvent: PointerEvent) => {
        const deltaPx = moveEvent.clientX - lastX;
        lastX = moveEvent.clientX;
        this.resize(deltaPx / containerWidth);
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp, { once: true });
    });

    return handle;
  }

  private resize(delta: number): void {
    const id = this.node.attrs.id;
    if (typeof id !== "string") return;
    resizeColumnBoundary(this.editor, id, delta);
  }

  private syncHandleLabel(handle: HTMLButtonElement): void {
    const percent = Math.round(widthOf(this.node) * 100);
    handle.setAttribute("aria-label", "Redimensionar colunas");
    handle.setAttribute("aria-valuemin", String(Math.round(COLUMN_MIN_WIDTH * 100)));
    handle.setAttribute("aria-valuemax", String(Math.round((1 - COLUMN_MIN_WIDTH) * 100)));
    handle.setAttribute("aria-valuenow", String(percent));
    handle.setAttribute("aria-valuetext", `Coluna com ${percent}% da largura`);
  }

  private syncWrapperWidth(): void {
    const wrapper = this.dom.parentElement;
    if (!wrapper) return;
    const percent = (widthOf(this.node) * 100).toFixed(2);
    wrapper.style.flex = `0 0 ${percent}%`;
    wrapper.style.minWidth = "0";
  }

  update(node: PMNode): boolean {
    if (node.type.name !== COLUMN_NODE_NAME) return false;
    this.node = node;
    if (typeof node.attrs.id === "string") this.dom.setAttribute("data-block-id", node.attrs.id);
    this.dom.setAttribute("data-width", String(widthOf(node)));
    this.syncHandleLabel(this.handle);
    this.syncHandleVisibility();
    this.syncWrapperWidth();
    return true;
  }
}

export function columnNodeView(props: NodeViewRendererProps): NodeView {
  return new ColumnNodeView(props);
}
