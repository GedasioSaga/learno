/**
 * EDT-028's "clicável": opens a bookmark's URL in the system browser inside
 * the Tauri app (`@tauri-apps/plugin-opener`, already a dependency), and
 * falls back to a normal new tab outside it (`vitest`, `vite dev` in a
 * browser) - the same isTauri()-gated split `core/blocks-api.ts` uses.
 */
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseSafeUrl } from "./bookmark-card";

export async function openBookmarkUrl(url: string): Promise<void> {
  const safe = parseSafeUrl(url);
  if (!safe) return; // hostile or malformed scheme - never hand this to the OS opener or window.open
  if (isTauri()) {
    await openUrl(safe.toString());
    return;
  }
  window.open(safe.toString(), "_blank", "noopener,noreferrer");
}
