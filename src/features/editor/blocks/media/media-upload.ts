/**
 * O que acontece entre "usuário escolheu um arquivo" (clique no botão de
 * upload de um bloco vazio, ou Ctrl/Cmd+V com uma imagem no clipboard) e
 * "o bloco mostra a mídia pronta" - usado tanto pelo NodeView de cada tipo
 * (`media-node-view.ts`) quanto pelo plugin de colar (`media-paste.ts`), para
 * que os dois caminhos gravem e reportem erro exatamente da mesma forma.
 *
 * `storeMediaFile` é assíncrono, mas o nó já precisa existir (ou já ter sido
 * inserido) antes dele resolver, para o usuário ver "Enviando…" em vez de
 * nada acontecer. A costura entre os dois momentos é `uploadToken`: um attr
 * transitório (nunca persistido - ver `register.ts`'s `serialization`) que
 * marca o nó certo mesmo se sua posição no documento mudar enquanto o
 * upload está em voo.
 */
import type { Editor } from "@tiptap/core";
import { insertBlockHere } from "../../core/commands";
import { storeMediaFile } from "./media-storage";
import {
  AUDIO_MAX_BYTES,
  AUDIO_MIME_TYPES,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  IMAGE_MIME_TYPES,
  validateMediaFile,
  VIDEO_MAX_BYTES,
  VIDEO_MIME_TYPES,
} from "./media-validation";

export interface MediaKind {
  nodeName: string;
  /** `null` = qualquer tipo aceito (bloco de arquivo). */
  mimeTypes: readonly string[] | null;
  maxBytes: number;
}

export const IMAGE_KIND: MediaKind = { nodeName: "image", mimeTypes: IMAGE_MIME_TYPES, maxBytes: IMAGE_MAX_BYTES };
export const VIDEO_KIND: MediaKind = { nodeName: "video", mimeTypes: VIDEO_MIME_TYPES, maxBytes: VIDEO_MAX_BYTES };
export const AUDIO_KIND: MediaKind = { nodeName: "audio", mimeTypes: AUDIO_MIME_TYPES, maxBytes: AUDIO_MAX_BYTES };
export const FILE_KIND: MediaKind = { nodeName: "file", mimeTypes: null, maxBytes: FILE_MAX_BYTES };

function findPosByUploadToken(editor: Editor, token: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.attrs.uploadToken === token) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

function finalizeUpload(editor: Editor, token: string, patch: Record<string, unknown>): void {
  const pos = findPosByUploadToken(editor, token);
  // O nó pode ter sido apagado (undo, Backspace) enquanto o upload estava em
  // voo - nada a fazer nesse caso, o arquivo já gravado só fica órfão.
  if (pos === null) return;
  const tr = editor.state.tr;
  tr.setNodeAttribute(pos, "uploadToken", null);
  tr.setNodeAttribute(pos, "loading", false);
  for (const [key, value] of Object.entries(patch)) tr.setNodeAttribute(pos, key, value);
  editor.view.dispatch(tr);
}

/** O nó de mídia em `pos` já existe (veio do menu "/" vazio, ou de um upload anterior com erro) - só preenche. Usado pelo botão "Enviar arquivo" do NodeView. */
export async function fillMediaNode(editor: Editor, pos: number, kind: MediaKind, file: File): Promise<void> {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const validation = validateMediaFile(file, kind.mimeTypes, kind.maxBytes);
  if (!validation.ok) {
    editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, "error", validation.reason ?? "Arquivo inválido."));
    return;
  }

  const token = crypto.randomUUID();
  const start = editor.state.tr;
  start.setNodeAttribute(pos, "uploadToken", token);
  start.setNodeAttribute(pos, "loading", true);
  start.setNodeAttribute(pos, "error", null);
  start.setNodeAttribute(pos, "fileName", file.name);
  start.setNodeAttribute(pos, "mimeType", file.type);
  start.setNodeAttribute(pos, "size", file.size);
  editor.view.dispatch(start);

  try {
    const stored = await storeMediaFile(file);
    finalizeUpload(editor, token, { src: stored.src });
  } catch {
    finalizeUpload(editor, token, { error: "Falha ao salvar o arquivo." });
  }
}

/** Nenhum nó ainda existe - cria um (convertendo o bloco vazio sob o cursor, ou inserindo um irmão, via `insertBlockHere`) já em estado "carregando". Usado pelo colar (EDT-061), onde o arquivo chega antes de qualquer bloco. `false` quando o arquivo não passa na validação ou não há onde inserir - nada muda no documento nesse caso. */
export async function insertMediaFromFile(editor: Editor, kind: MediaKind, file: File): Promise<boolean> {
  const validation = validateMediaFile(file, kind.mimeTypes, kind.maxBytes);
  if (!validation.ok) return false;

  const token = crypto.randomUUID();
  const inserted = insertBlockHere(editor, kind.nodeName, {
    uploadToken: token,
    loading: true,
    fileName: file.name,
    mimeType: file.type,
    size: file.size,
  });
  if (!inserted) return false;

  try {
    const stored = await storeMediaFile(file);
    finalizeUpload(editor, token, { src: stored.src });
  } catch {
    finalizeUpload(editor, token, { error: "Falha ao salvar o arquivo." });
  }
  return true;
}
