/**
 * Auto-discovery for `registry.ts`: importing this module eagerly loads
 * every `register.ts` under the sibling extension folders, so a new builder
 * never has to edit a shared list - dropping the file in is enough. See the
 * README for the full rationale.
 *
 * `import.meta.glob`'s patterns are resolved by Vite at build/dev-server
 * start, so a brand new folder (not just a new file in an existing one)
 * needs a dev-server restart to be picked up - a one-time cost when a
 * builder's folder doesn't exist yet, documented in the README rather than
 * hidden here.
 */
const modules = import.meta.glob(
  [
    "../marks/**/register.ts",
    "../blocks/**/register.ts",
    "../interaction/**/register.ts",
    "../synced/**/register.ts",
  ],
  { eager: true },
);

/** Only real work: give something for `Editor.tsx` to import so bundlers don't tree-shake the glob's side effects away. */
export function ensureExtensionsDiscovered(): void {
  void modules;
}
