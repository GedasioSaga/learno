/**
 * The extension point every other builder (marks/, blocks/, interaction/,
 * synced/) uses to add to the editor without touching a file this builder
 * owns. See `discover-extensions.ts` for how their registrations get here
 * without anyone importing anyone, and the README for the full picture.
 */
import type { AnyExtension } from "@tiptap/core";

const registered: AnyExtension[] = [];

/** Call once, at module load, from your own `register.ts` (discovered automatically - see `discover-extensions.ts`). Registering the same extension instance twice (e.g. hot reload re-running the module) is a no-op. */
export function registerBlockExtension(extension: AnyExtension | AnyExtension[]): void {
  const list = Array.isArray(extension) ? extension : [extension];
  for (const ext of list) {
    if (!registered.includes(ext)) registered.push(ext);
  }
}

/** Snapshot for `Editor.tsx` to spread into its extensions array - a copy, so nothing outside this module can mutate the live registry. */
export function collectRegisteredExtensions(): AnyExtension[] {
  return [...registered];
}
