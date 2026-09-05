/**
 * Os quatro tipos de nó ProseMirror (EDT-024/025/026/027). Todos átomos no
 * grupo "blockContent" (`content: ""`, `atom: true`) - nunca "block": um nó
 * nesse grupo aparece solto sob `doc` e `docToFlatBlocks` o ignora em
 * silêncio, ver README. `addNodeView` é onde cada um difere de verdade
 * (`renderImage`/`renderVideo`/`renderAudio`/`renderFile`); o resto do
 * esqueleto vem de `createMediaNodeView` (`media-node-view.ts`).
 */
import type { Editor } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createMediaNodeView } from "./media-node-view";
import { AUDIO_KIND, FILE_KIND, IMAGE_KIND, VIDEO_KIND } from "./media-upload";

export const IMAGE_MIN_WIDTH_PERCENT = 20;
export const IMAGE_MAX_WIDTH_PERCENT = 100;
export const IMAGE_DEFAULT_WIDTH_PERCENT = 100;
/** Quanto uma seta do teclado move a borda de redimensionamento por vez. */
const IMAGE_WIDTH_KEYBOARD_STEP = 5;

export function clampImageWidth(value: number): number {
  return Math.min(IMAGE_MAX_WIDTH_PERCENT, Math.max(IMAGE_MIN_WIDTH_PERCENT, Math.round(value)));
}

/** `data-block-id`, igual ao `idAttribute` de `core/schema.ts` - mesma convenção, não importado de lá porque é interno ao módulo e o README pede para não editar `core/`, não que eu não possa reimplementar um attr tão pequeno. */
function idAttribute() {
  return {
    id: {
      // `as` aqui só amplia o literal `null` (que o TS infere como o tipo
      // `null` sozinho) para o tipo real do campo - mesma necessidade do
      // `idAttribute` de `core/schema.ts`, nunca um cast que force algo
      // incompatível.
      default: null as string | null,
      parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes.id ? { "data-block-id": attributes.id } : {},
    },
  };
}

/**
 * Attrs comuns aos quatro tipos. `loading`/`error`/`uploadToken` são estado
 * transitório da sessão de edição, nunca escrito em `content` (ver
 * `register.ts`'s `serialization.content`, que só lê os campos abaixo de
 * `src`) - refletem só o que está em voo, não o que já foi salvo.
 */
function mediaAttributes() {
  return {
    ...idAttribute(),
    src: { default: "" },
    fileName: { default: "" },
    mimeType: { default: "" },
    size: { default: 0 },
    loading: { default: false },
    // Mesma razão do `id` acima: só amplia o literal `null` para o tipo real do campo.
    error: { default: null as string | null },
    uploadToken: { default: null as string | null },
  };
}

function renderImage(body: HTMLElement, node: PMNode, url: string, editor: Editor, getPos: () => number | undefined) {
  const wrap = document.createElement("div");
  wrap.className = "ed-media__image-wrap";
  const currentWidth = clampImageWidth(Number(node.attrs.width) || IMAGE_DEFAULT_WIDTH_PERCENT);
  wrap.style.width = `${currentWidth}%`;

  const img = document.createElement("img");
  img.src = url;
  img.alt = String(node.attrs.caption ?? "");
  img.className = "ed-media__image";
  wrap.append(img);
  wrap.append(buildResizeHandle(wrap, node, editor, getPos));
  body.append(wrap);
  body.append(buildCaptionInput(node, editor, getPos));
}

/** EDT-024: arrasta pela borda para redimensionar, largura persistida em `content.width` (setas do teclado fazem o mesmo em passos fixos, já que o handle é focável). */
function buildResizeHandle(
  wrap: HTMLDivElement,
  node: PMNode,
  editor: Editor,
  getPos: () => number | undefined,
): HTMLDivElement {
  const handle = document.createElement("div");
  handle.className = "ed-media__resize-handle";
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", "Redimensionar imagem");
  handle.setAttribute("aria-valuemin", String(IMAGE_MIN_WIDTH_PERCENT));
  handle.setAttribute("aria-valuemax", String(IMAGE_MAX_WIDTH_PERCENT));
  handle.tabIndex = 0;

  const currentWidth = () => clampImageWidth(Number(node.attrs.width) || IMAGE_DEFAULT_WIDTH_PERCENT);
  handle.setAttribute("aria-valuenow", String(currentWidth()));

  function commitWidth(width: number): void {
    const pos = getPos();
    if (pos === undefined) return;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "width", width));
  }

  handle.addEventListener("mousedown", (downEvent) => {
    downEvent.preventDefault();
    const parentWidth = wrap.parentElement?.clientWidth || wrap.clientWidth || 1;
    const startX = downEvent.clientX;
    const startWidth = currentWidth();
    let liveWidth = startWidth;

    function onMove(moveEvent: MouseEvent) {
      const deltaPercent = ((moveEvent.clientX - startX) / parentWidth) * 100;
      liveWidth = clampImageWidth(startWidth + deltaPercent);
      wrap.style.width = `${liveWidth}%`;
      handle.setAttribute("aria-valuenow", String(liveWidth));
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      commitWidth(liveWidth);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  handle.addEventListener("keydown", (keyEvent) => {
    const step =
      keyEvent.key === "ArrowLeft" ? -IMAGE_WIDTH_KEYBOARD_STEP : keyEvent.key === "ArrowRight" ? IMAGE_WIDTH_KEYBOARD_STEP : 0;
    if (step === 0) return;
    keyEvent.preventDefault();
    commitWidth(clampImageWidth(currentWidth() + step));
  });

  return handle;
}

/** EDT-024: legenda opcional, gravada em `content.caption`. */
function buildCaptionInput(node: PMNode, editor: Editor, getPos: () => number | undefined): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ed-media__caption";
  input.placeholder = "Legenda (opcional)";
  input.setAttribute("aria-label", "Legenda da imagem");
  input.value = String(node.attrs.caption ?? "");
  input.addEventListener("change", () => {
    const pos = getPos();
    if (pos === undefined) return;
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "caption", input.value));
  });
  return input;
}

function renderVideo(body: HTMLElement, node: PMNode, url: string) {
  const video = document.createElement("video");
  video.src = url;
  video.controls = true;
  video.className = "ed-media__video";
  video.setAttribute("aria-label", String(node.attrs.fileName || "Vídeo"));
  body.append(video);
}

function renderAudio(body: HTMLElement, node: PMNode, url: string) {
  const audio = document.createElement("audio");
  audio.src = url;
  audio.controls = true;
  audio.className = "ed-media__audio";
  audio.setAttribute("aria-label", String(node.attrs.fileName || "Áudio"));
  body.append(audio);
}

function renderFile(body: HTMLElement, node: PMNode, url: string) {
  const fileName = String(node.attrs.fileName || "Arquivo");
  const row = document.createElement("div");
  row.className = "ed-media__file-row";

  const icon = document.createElement("span");
  icon.className = "ed-media__file-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "📄";

  const name = document.createElement("span");
  name.className = "ed-media__file-name";
  name.textContent = fileName;

  const link = document.createElement("a");
  link.className = "ed-media__file-link";
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.download = fileName;
  link.textContent = "Abrir";
  link.setAttribute("aria-label", `Abrir ${fileName}`);

  row.append(icon, name, link);
  body.append(row);
}

export const ImageBlock = Node.create({
  name: "image",
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return { ...mediaAttributes(), caption: { default: "" }, width: { default: IMAGE_DEFAULT_WIDTH_PERCENT } };
  },
  parseHTML() {
    return [{ tag: 'div[data-block-type="image"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": "image",
        class: "ed-block ed-media ed-media--image",
        contenteditable: "false",
      }),
    ];
  },
  addNodeView() {
    return createMediaNodeView({
      kind: IMAGE_KIND,
      nodeName: "image",
      cssModifier: "image",
      pickLabel: "Enviar imagem",
      allowUrl: true,
      renderMedia: renderImage,
    });
  },
});

export const VideoBlock = Node.create({
  name: "video",
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return mediaAttributes();
  },
  parseHTML() {
    return [{ tag: 'div[data-block-type="video"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": "video",
        class: "ed-block ed-media ed-media--video",
        contenteditable: "false",
      }),
    ];
  },
  addNodeView() {
    return createMediaNodeView({
      kind: VIDEO_KIND,
      nodeName: "video",
      cssModifier: "video",
      pickLabel: "Enviar vídeo",
      renderMedia: renderVideo,
    });
  },
});

export const AudioBlock = Node.create({
  name: "audio",
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return mediaAttributes();
  },
  parseHTML() {
    return [{ tag: 'div[data-block-type="audio"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": "audio",
        class: "ed-block ed-media ed-media--audio",
        contenteditable: "false",
      }),
    ];
  },
  addNodeView() {
    return createMediaNodeView({
      kind: AUDIO_KIND,
      nodeName: "audio",
      cssModifier: "audio",
      pickLabel: "Enviar áudio",
      renderMedia: renderAudio,
    });
  },
});

export const FileBlock = Node.create({
  name: "file",
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return mediaAttributes();
  },
  parseHTML() {
    return [{ tag: 'div[data-block-type="file"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": "file",
        class: "ed-block ed-media ed-media--file",
        contenteditable: "false",
      }),
    ];
  },
  addNodeView() {
    return createMediaNodeView({
      kind: FILE_KIND,
      nodeName: "file",
      cssModifier: "file",
      pickLabel: "Enviar arquivo",
      renderMedia: renderFile,
    });
  },
});
