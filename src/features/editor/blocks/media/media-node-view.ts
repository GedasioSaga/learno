/**
 * O NodeView compartilhado pelos quatro tipos de mídia: cada um só difere em
 * como desenha o corpo depois que a URL está resolvida (`renderMedia`) e no
 * rótulo do botão de upload - o esqueleto (estado vazio/carregando/erro,
 * resolver `src` via `resolveMediaSrc`, o campo de URL da imagem) é um só,
 * para não repetir a mesma máquina de estados quatro vezes.
 *
 * Vanilla `NodeView` (não `ReactNodeViewRenderer`), pelo mesmo motivo de
 * `core/node-views.ts`: nenhum destes nós tem estado de edição rico o
 * bastante pra justificar uma subárvore React inteira por bloco.
 */
import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { fillMediaNode, type MediaKind } from "./media-upload";
import { resolveMediaSrc } from "./media-storage";

export type RenderMedia = (
  body: HTMLElement,
  node: PMNode,
  url: string,
  editor: Editor,
  getPos: () => number | undefined,
) => void;

export interface MediaNodeViewOptions {
  kind: MediaKind;
  /** Precisa bater com `Node.create({ name })` do tipo - usado só pra `update()` recusar um nó de outro tipo. */
  nodeName: string;
  cssModifier: string;
  pickLabel: string;
  /** Só a imagem aceita URL direta em vez de upload (EDT-024). */
  allowUrl?: boolean;
  renderMedia: RenderMedia;
}

/**
 * Devolve um `NodeViewRenderer` de verdade (`(props) => NodeView`), não a
 * classe em si - `addNodeView()` (`Node.create`'s `NodeConfig`) exige essa
 * forma de função, a mesma que `core/node-views.ts`'s `todoItemNodeView`/
 * `toggleNodeView` usam para as duas fábricas que devolvem `new ...View(props)`.
 */
export function createMediaNodeView(options: MediaNodeViewOptions): (props: NodeViewRendererProps) => NodeView {
  const MediaNodeView = class implements NodeView {
    dom: HTMLElement;
    private body: HTMLElement;
    private node: PMNode;
    private editor: Editor;
    private getPos: () => number | undefined;
    private renderToken = 0;

    constructor(props: NodeViewRendererProps) {
      this.node = props.node;
      this.editor = props.editor;
      this.getPos = props.getPos;
      this.dom = document.createElement("div");
      this.dom.className = `ed-block ed-media ed-media--${options.cssModifier}`;
      this.dom.setAttribute("data-block-type", options.nodeName);
      this.dom.setAttribute("contenteditable", "false");
      this.body = document.createElement("div");
      this.body.className = "ed-media__body";
      this.dom.append(this.body);
      this.render();
    }

    update(node: PMNode): boolean {
      if (node.type.name !== options.nodeName) return false;
      this.node = node;
      this.render();
      return true;
    }

    private render(): void {
      const attrs = this.node.attrs;
      if (typeof attrs.id === "string") this.dom.setAttribute("data-block-id", attrs.id);
      this.body.replaceChildren();
      this.renderToken += 1;
      const token = this.renderToken;

      if (attrs.error) {
        this.renderStatus(String(attrs.error), true);
        return;
      }
      if (attrs.loading) {
        this.renderStatus("Enviando…", false);
        return;
      }
      if (!attrs.src) {
        this.renderPicker();
        return;
      }
      void resolveMediaSrc(String(attrs.src)).then((url) => {
        // Um `update()` mais novo já rodou enquanto a resolução estava em
        // voo - o que ela ia desenhar não vale mais.
        if (token !== this.renderToken) return;
        if (!url) {
          this.renderStatus("Mídia não encontrada.", true);
          return;
        }
        options.renderMedia(this.body, this.node, url, this.editor, this.getPos);
      });
    }

    private renderStatus(message: string, isError: boolean): void {
      const el = document.createElement("p");
      el.className = isError ? "ed-media__status ed-media__status--error" : "ed-media__status";
      if (isError) el.setAttribute("role", "alert");
      el.textContent = message;
      this.body.append(el);
    }

    private renderPicker(): void {
      const wrap = document.createElement("div");
      wrap.className = "ed-media__picker";

      const input = document.createElement("input");
      input.type = "file";
      input.hidden = true;
      input.setAttribute("aria-hidden", "true");
      if (options.kind.mimeTypes) input.accept = options.kind.mimeTypes.join(",");
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        input.value = "";
        if (!file) return;
        void this.pickFile(file);
      });

      const button = document.createElement("button");
      button.type = "button";
      button.className = "ed-media__pick-button";
      button.textContent = options.pickLabel;
      button.setAttribute("aria-label", options.pickLabel);
      button.addEventListener("click", () => input.click());

      wrap.append(button, input);
      if (options.allowUrl) wrap.append(this.buildUrlForm());
      this.body.append(wrap);
    }

    private buildUrlForm(): HTMLFormElement {
      const form = document.createElement("form");
      form.className = "ed-media__url-form";
      const urlInput = document.createElement("input");
      urlInput.type = "url";
      urlInput.placeholder = "Ou cole uma URL de imagem";
      urlInput.setAttribute("aria-label", "URL da imagem");
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "Usar URL";
      form.append(urlInput, submit);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this.useUrl(urlInput.value);
      });
      return form;
    }

    private async pickFile(file: File): Promise<void> {
      const pos = this.getPos();
      if (pos === undefined) return;
      await fillMediaNode(this.editor, pos, options.kind, file);
    }

    private useUrl(rawUrl: string): void {
      const pos = this.getPos();
      if (pos === undefined) return;
      const trimmed = rawUrl.trim();
      if (!trimmed) return;
      this.editor.view.dispatch(this.editor.state.tr.setNodeAttribute(pos, "src", trimmed));
    }
  };

  return (props: NodeViewRendererProps) => new MediaNodeView(props);
}
