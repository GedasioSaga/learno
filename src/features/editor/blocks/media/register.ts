/**
 * Ponto de entrada único desta pasta - o único arquivo aqui chamado
 * "register.ts", descoberto por `core/discover-extensions.ts` via
 * `import.meta.glob`. Registra os quatro tipos de bloco de mídia
 * (EDT-024/025/026/027): a extensão TipTap de cada um, como persiste
 * (`BlockSpec`) e sua entrada no menu "/". EDT-061 (colar) entra como uma
 * quinta extensão, sem `BlockSpec` própria - ela só cria blocos de imagem já
 * cobertos pelo spec de imagem.
 */
import { insertBlockHere } from "../../core/commands";
import { registerBlockSpec, registerSlashMenuItem } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import "./media.css";
import { MediaPaste } from "./media-paste";
import { AudioBlock, FileBlock, IMAGE_DEFAULT_WIDTH_PERCENT, ImageBlock, VideoBlock } from "./media-nodes";

registerBlockExtension([ImageBlock, VideoBlock, AudioBlock, FileBlock, MediaPaste]);

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

registerBlockSpec([
  {
    blockType: "image",
    nodeName: "image",
    hasContent: false,
    serialization: {
      attrs: (_blockType, content) => ({
        src: readString(content.src),
        fileName: readString(content.fileName),
        mimeType: readString(content.mimeType),
        size: readNumber(content.size, 0),
        caption: readString(content.caption),
        width: readNumber(content.width, IMAGE_DEFAULT_WIDTH_PERCENT),
      }),
      content: (attrs) => ({
        src: readString(attrs.src),
        fileName: readString(attrs.fileName),
        mimeType: readString(attrs.mimeType),
        size: readNumber(attrs.size, 0),
        caption: readString(attrs.caption),
        width: readNumber(attrs.width, IMAGE_DEFAULT_WIDTH_PERCENT),
      }),
      plainText: (content) => readString(content.caption),
    },
  },
  {
    blockType: "video",
    nodeName: "video",
    hasContent: false,
    serialization: {
      attrs: (_blockType, content) => ({
        src: readString(content.src),
        fileName: readString(content.fileName),
        mimeType: readString(content.mimeType),
        size: readNumber(content.size, 0),
      }),
      content: (attrs) => ({
        src: readString(attrs.src),
        fileName: readString(attrs.fileName),
        mimeType: readString(attrs.mimeType),
        size: readNumber(attrs.size, 0),
      }),
      plainText: (content) => readString(content.fileName),
    },
  },
  {
    blockType: "audio",
    nodeName: "audio",
    hasContent: false,
    serialization: {
      attrs: (_blockType, content) => ({
        src: readString(content.src),
        fileName: readString(content.fileName),
        mimeType: readString(content.mimeType),
        size: readNumber(content.size, 0),
      }),
      content: (attrs) => ({
        src: readString(attrs.src),
        fileName: readString(attrs.fileName),
        mimeType: readString(attrs.mimeType),
        size: readNumber(attrs.size, 0),
      }),
      plainText: (content) => readString(content.fileName),
    },
  },
  {
    blockType: "file",
    nodeName: "file",
    hasContent: false,
    serialization: {
      attrs: (_blockType, content) => ({
        src: readString(content.src),
        fileName: readString(content.fileName),
        mimeType: readString(content.mimeType),
        size: readNumber(content.size, 0),
      }),
      content: (attrs) => ({
        src: readString(attrs.src),
        fileName: readString(attrs.fileName),
        mimeType: readString(attrs.mimeType),
        size: readNumber(attrs.size, 0),
      }),
      plainText: (content) => readString(content.fileName),
    },
  },
]);

const MEDIA_GROUP = "Mídia";

registerSlashMenuItem([
  {
    id: "blocks-media:image",
    title: "Imagem",
    keywords: ["imagem", "image", "foto", "figura"],
    group: MEDIA_GROUP,
    icon: "🖼",
    order: 0,
    run: (editor) => insertBlockHere(editor, "image", { width: IMAGE_DEFAULT_WIDTH_PERCENT }),
  },
  {
    id: "blocks-media:video",
    title: "Vídeo",
    keywords: ["video", "filme", "mp4"],
    group: MEDIA_GROUP,
    icon: "🎬",
    order: 1,
    run: (editor) => insertBlockHere(editor, "video"),
  },
  {
    id: "blocks-media:audio",
    title: "Áudio",
    keywords: ["audio", "som", "mp3"],
    group: MEDIA_GROUP,
    icon: "🎵",
    order: 2,
    run: (editor) => insertBlockHere(editor, "audio"),
  },
  {
    id: "blocks-media:file",
    title: "Arquivo anexado",
    keywords: ["arquivo", "anexo", "file", "pdf", "documento"],
    group: MEDIA_GROUP,
    icon: "📎",
    order: 3,
    run: (editor) => insertBlockHere(editor, "file"),
  },
]);
