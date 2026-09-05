/**
 * Onde o byte de mídia mora - a decisão central desta peça. O Learno não tem
 * servidor, só um Postgres local; base64 dentro do `content` JSONB do bloco
 * estoura banco e memória para vídeo e arquivo, e é ruim até para imagem. O
 * byte vai então para um arquivo dentro de uma subpasta "media" da pasta de
 * dados do app (`getDataDir`, Fase 1), nomeado pelo hash do próprio
 * conteúdo (deduplica e evita colisão de nome) - só o nome desse arquivo
 * ("<hash><extensão>") persiste em `content.src`.
 *
 * Fora do Tauri (vite dev num browser comum, e todo `vitest`) não há FS: cai
 * num modo em memória com `URL.createObjectURL`, atrás desta mesma função
 * pequena, para o teste rodar sem mockar `@tauri-apps/plugin-fs`.
 */
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { getDataDir } from "../../../../lib/ipc";

const MEDIA_SUBDIR = "media";

/** Só preenchido fora do Tauri: chave opaca -> blob URL desta sessão. Nunca sobrevive a um reload da página, o que é aceitável fora do app real (dev num browser comum, ou um teste). */
const inMemoryUrls = new Map<string, string>();

export interface StoredMedia {
  /** O que persiste em `content.src`. */
  src: string;
  /** URL utilizável agora, nesta sessão, num `<img>`/`<video>`/`<a href>`. */
  url: string;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot);
}

/**
 * `URL.createObjectURL` não existe no jsdom (todo `vitest` roda nele) -
 * ausente de propósito lá, não um bug de configuração. O valor só precisa
 * ser uma string estável que `inMemoryUrls` devolve depois pela mesma
 * chave, então uma URL sintética serve igual num teste; browser real e
 * Tauri sempre têm a API de verdade.
 */
function createObjectUrl(file: File): string {
  if (typeof URL.createObjectURL === "function") return URL.createObjectURL(file);
  return `jsdom-stub:${file.name}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function mediaDirPath(): Promise<string> {
  const configured = await getDataDir();
  const base = configured ?? (await appDataDir());
  return join(base, MEDIA_SUBDIR);
}

/**
 * Grava um `File` e devolve o par (caminho persistido, URL exibível agora).
 * O hash já deduplica, então nunca precisa se preocupar com colisão de nome
 * nem regravar um arquivo idêntico.
 */
export async function storeMediaFile(file: File): Promise<StoredMedia> {
  if (!isTauri()) {
    const key = `blob:${crypto.randomUUID()}${extensionOf(file.name)}`;
    const url = createObjectUrl(file);
    inMemoryUrls.set(key, url);
    return { src: key, url };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileName = `${await sha256Hex(bytes)}${extensionOf(file.name)}`;
  const dir = await mediaDirPath();
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  const fullPath = await join(dir, fileName);
  if (!(await exists(fullPath))) await writeFile(fullPath, bytes);
  return { src: fileName, url: convertFileSrc(fullPath) };
}

/** `true` para uma imagem inserida por URL externa (EDT-024) - nunca passa pelo storage local, então nunca deve ser resolvida como caminho relativo. */
export function isExternalMediaUrl(src: string): boolean {
  return /^(https?:|data:)/.test(src);
}

/**
 * O caminho persistido (`content.src`) de volta para uma URL exibível - a
 * mesma tradução nos dois sentidos de `storeMediaFile`, para que um bloco
 * recarregado do banco resolva sua própria mídia sem saber se está rodando
 * dentro do Tauri ou não. `""` quando não há nada para resolver (bloco
 * ainda sem arquivo, ou uma chave de sessão anterior que já não existe mais
 * em memória).
 */
export async function resolveMediaSrc(src: string): Promise<string> {
  if (!src) return "";
  if (isExternalMediaUrl(src)) return src;
  if (!isTauri()) return inMemoryUrls.get(src) ?? "";
  const dir = await mediaDirPath();
  const fullPath = await join(dir, src);
  return convertFileSrc(fullPath);
}
