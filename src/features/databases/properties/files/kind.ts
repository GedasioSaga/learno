/**
 * Classifica um `File` do navegador num dos quatro `FileRef["kind"]`
 * (`contract.ts`) e escolhe o limite de validação certo para cada um —
 * MESMAS listas de MIME e teto de tamanho que os blocos de mídia do editor
 * usam (`editor/blocks/media/media-validation.ts`), para "imagem" e o teto
 * de vídeo não divergirem entre editor e database. Reuso, não reinvenção —
 * exatamente o que o briefing desta peça pede.
 */
import {
  AUDIO_MAX_BYTES,
  AUDIO_MIME_TYPES,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  IMAGE_MIME_TYPES,
  validateMediaFile,
  VIDEO_MAX_BYTES,
  VIDEO_MIME_TYPES,
  type FileValidation,
} from "../../../editor/blocks/media/media-validation";
import type { FileRef } from "../../contract";

// As constantes do editor são tuplas `as const` (união de literais); alargar
// para `readonly string[]` aqui é o MESMO padrão que `validateMediaFile` já
// usa no próprio parâmetro — sem isso, `.includes(file.type)` não compila
// porque `file.type` é `string` solto, não um dos literais da tupla.
const IMAGE_TYPES: readonly string[] = IMAGE_MIME_TYPES;
const VIDEO_TYPES: readonly string[] = VIDEO_MIME_TYPES;
const AUDIO_TYPES: readonly string[] = AUDIO_MIME_TYPES;

/** Deriva o `kind` do MIME reportado pelo navegador/SO. Nunca lança — MIME desconhecido cai em "file", o kind sem allowlist. */
export function classifyFileKind(mimeType: string): FileRef["kind"] {
  if (IMAGE_TYPES.includes(mimeType)) return "image";
  if (VIDEO_TYPES.includes(mimeType)) return "video";
  if (AUDIO_TYPES.includes(mimeType)) return "audio";
  return "file";
}

interface KindLimit {
  mimeTypes: readonly string[] | null;
  maxBytes: number;
}

const LIMITS: Record<FileRef["kind"], KindLimit> = {
  image: { mimeTypes: IMAGE_TYPES, maxBytes: IMAGE_MAX_BYTES },
  video: { mimeTypes: VIDEO_TYPES, maxBytes: VIDEO_MAX_BYTES },
  audio: { mimeTypes: AUDIO_TYPES, maxBytes: AUDIO_MAX_BYTES },
  // "file" não é só o resíduo de MIME desconhecido: é a MESMA decisão do
  // bloco "Arquivo anexado" do editor — sem allowlist de propósito, só o
  // tamanho é limitado (documento pode ser pdf, docx, zip...).
  file: { mimeTypes: null, maxBytes: FILE_MAX_BYTES },
};

/** Valida um `File` antes de anexá-lo à propriedade — mesma `validateMediaFile` do editor, limite escolhido pelo kind detectado a partir do MIME. */
export function validateAttachment(file: File): FileValidation {
  const limit = LIMITS[classifyFileKind(file.type)];
  return validateMediaFile(file, limit.mimeTypes, limit.maxBytes);
}
