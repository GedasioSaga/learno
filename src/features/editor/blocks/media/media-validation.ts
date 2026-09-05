/**
 * Limites de aceitação por tipo de bloco de mídia (EDT-024/025/026/027):
 * tipo MIME esperado e teto de tamanho, cada um numa const nomeada, porque
 * entrada de usuário é hostil por padrão mesmo vindo do sistema de arquivos
 * local (não da rede) - um arquivo com nome "foto.png" ainda declara seu
 * próprio `File.type` pelo navegador/SO, então checar o MIME barra o caso
 * comum sem precisar abrir um parser de bytes aqui. "Arquivo anexado" não
 * tem allowlist de MIME de propósito - é o único dos quatro pensado para
 * qualquer tipo de documento (pdf, docx, zip...), só o tamanho é limitado.
 */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;
export const VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime"] as const;
export const AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/mp4",
  "audio/x-m4a",
] as const;

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const AUDIO_MAX_BYTES = 100 * 1024 * 1024;
export const FILE_MAX_BYTES = 100 * 1024 * 1024;

export interface FileValidation {
  ok: boolean;
  reason?: string;
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** `allowedMimeTypes: null` significa "qualquer tipo aceito" (o caso do bloco de arquivo). */
export function validateMediaFile(
  file: File,
  allowedMimeTypes: readonly string[] | null,
  maxBytes: number,
): FileValidation {
  if (file.size === 0) return { ok: false, reason: "O arquivo está vazio." };
  if (file.size > maxBytes) {
    return { ok: false, reason: `O arquivo passa do limite de ${megabytes(maxBytes)} MB.` };
  }
  if (allowedMimeTypes && !allowedMimeTypes.includes(file.type)) {
    return { ok: false, reason: `Tipo "${file.type || "desconhecido"}" não é aceito aqui.` };
  }
  return { ok: true };
}
