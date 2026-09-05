/**
 * NodeView vanilla (não `ReactNodeViewRenderer`, mesmo raciocínio de
 * `core/node-views.ts`: nada aqui tem estado próprio além dos attrs do nó)
 * para o bloco de código: cabeçalho com seletor de linguagem + botão de
 * copiar, e o `<pre><code>` onde o ProseMirror escreve o texto e o plugin do
 * lowlight (registrado em `code-block.ts`, via `CodeBlockLowlight`) aplica as
 * decorações de realce.
 */
import type { NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView, ViewMutationRecord } from "@tiptap/pm/view";
import { CODE_BLOCK_NODE_NAME, CODE_LANGUAGES, DEFAULT_CODE_LANGUAGE } from "./languages";

/** Tempo que o botão mostra "Copiado!" antes de voltar ao rótulo normal. */
const COPY_RESET_DELAY_MS = 1500;

class CodeBlockNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private readonly header: HTMLElement;
  private readonly languageSelect: HTMLSelectElement;
  private readonly copyButton: HTMLButtonElement;
  private copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({ node, editor, getPos }: NodeViewRendererProps) {
    this.node = node;

    this.dom = document.createElement("div");
    this.dom.className = "ed-block ed-code-block";
    this.dom.setAttribute("data-block-type", "code");
    if (typeof node.attrs.id === "string") this.dom.setAttribute("data-block-id", node.attrs.id);

    this.header = document.createElement("div");
    this.header.className = "ed-code-block__header";
    // Não é conteúdo do documento - contenteditable=false evita que um
    // clique no cabeçalho vire ponto de edição de texto.
    this.header.setAttribute("contenteditable", "false");

    this.languageSelect = document.createElement("select");
    this.languageSelect.className = "ed-code-block__language";
    this.languageSelect.setAttribute("aria-label", "Linguagem do bloco de código");
    for (const language of CODE_LANGUAGES) {
      const option = document.createElement("option");
      option.value = language.value;
      option.textContent = language.label;
      this.languageSelect.append(option);
    }
    this.syncLanguageSelect();
    this.languageSelect.addEventListener("change", () => {
      const pos = getPos();
      if (pos === undefined) return;
      editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "language", this.languageSelect.value));
    });

    this.copyButton = document.createElement("button");
    this.copyButton.type = "button";
    this.copyButton.className = "ed-code-block__copy";
    this.copyButton.textContent = "Copiar";
    this.copyButton.setAttribute("aria-label", "Copiar código");
    this.copyButton.addEventListener("click", (event) => {
      event.preventDefault();
      void this.copyCode();
    });

    this.header.append(this.languageSelect, this.copyButton);

    const pre = document.createElement("pre");
    pre.className = "ed-code-block__pre";
    this.contentDOM = document.createElement("code");
    this.contentDOM.className = "ed-code-block__code hljs";
    pre.append(this.contentDOM);

    this.dom.append(this.header, pre);
  }

  private syncLanguageSelect(): void {
    const language = typeof this.node.attrs.language === "string" ? this.node.attrs.language : DEFAULT_CODE_LANGUAGE;
    this.languageSelect.value = language;
  }

  private async copyCode(): Promise<void> {
    const text = this.node.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard indisponível (permissão negada, contexto não seguro): o
      // botão não trava, só não confirma a cópia - falha silenciosa é o
      // comportamento certo aqui, não há erro para o usuário corrigir.
      return;
    }
    this.copyButton.textContent = "Copiado!";
    if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
    this.copyResetTimer = setTimeout(() => {
      this.copyButton.textContent = "Copiar";
      this.copyResetTimer = null;
    }, COPY_RESET_DELAY_MS);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== CODE_BLOCK_NODE_NAME) return false;
    this.node = node;
    this.syncLanguageSelect();
    return true;
  }

  // O cabeçalho (seletor + botão) fica fora do `contentDOM` de propósito -
  // sem isso o ProseMirror tentaria interpretar clique/seleção nele como
  // edição do texto do bloco.
  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.header.contains(event.target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.target instanceof Node && this.header.contains(mutation.target);
  }

  destroy(): void {
    if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
  }
}

export function codeBlockNodeView(props: NodeViewRendererProps): NodeView {
  return new CodeBlockNodeView(props);
}
