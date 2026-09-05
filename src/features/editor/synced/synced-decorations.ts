/**
 * EDT-073's visual indicator: a small badge on any block this browser knows
 * is a synced origin or copy (`synced-store.ts`'s `allKnownSyncedIds()`).
 *
 * Built as ProseMirror `Decoration`s, not a node attribute - `schema.ts`'s
 * nine block types only expose the attrs each one declares in its own
 * `addAttributes()` (`id`, `level`, `checked`, ...), and `synced/` cannot
 * add to that without editing `core/schema.ts`. A decoration keyed off the
 * `id` every `blockContent` node already carries needs no schema change at
 * all - see the README's `core_gaps` note in this builder's report for why
 * that's the only way in.
 */
import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { BlockId } from "../contract";
import { BLOCK_NODE_NAMES } from "../core/node-names";
import { allKnownSyncedIds } from "./synced-store";

const SYNCED_BADGE_CLASS = "ed-synced-badge";

function buildBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = SYNCED_BADGE_CLASS;
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", "Bloco sincronizado");
  badge.textContent = "🔗";
  return badge;
}

/**
 * Pure so it can be tested directly against a doc built from JSON, without a
 * live `EditorView`. Decorates every `blockContent` node (not the `Block`
 * wrapper, which has no `id` of its own - see `schema.ts`) whose `id` is in
 * `knownIds`: a node decoration for CSS styling on `.ed-block`, plus a
 * widget badge right before its text.
 */
export function buildSyncedDecorations(doc: PMNode, knownIds: Set<BlockId>): DecorationSet {
  if (knownIds.size === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    // Widened the same way `core/commands.ts`'s own `isBlockContentNode` is:
    // `BLOCK_NODE_NAMES` is a fixed literal-string union array, `.includes`
    // needs `string` to accept `node.type.name`'s wider runtime type.
    if (!(BLOCK_NODE_NAMES as readonly string[]).includes(node.type.name)) return true;
    const id = node.attrs.id;
    if (typeof id !== "string" || !knownIds.has(id)) return true;

    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "ed-synced" }));
    decorations.push(Decoration.widget(pos + 1, buildBadge, { side: -1, key: `synced-badge-${id}` }));
    return true;
  });

  return DecorationSet.create(doc, decorations);
}

export const syncedIndicatorPluginKey = new PluginKey<DecorationSet>("syncedIndicator");

function createSyncedIndicatorPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: syncedIndicatorPluginKey,
    state: {
      init: (_config, state) => buildSyncedDecorations(state.doc, allKnownSyncedIds()),
      apply(tr, old, _oldState, newState) {
        // Recomputes whenever the doc actually changed (a new copy pasted
        // in, say) or when `refreshSyncedIndicators` asked for it (a synced
        // action finished and `synced-store.ts` now knows something new) -
        // anything else (a plain selection move) reuses the same set rather
        // than re-walking the whole doc on every keystroke.
        if (!tr.docChanged && tr.getMeta(syncedIndicatorPluginKey) === undefined) return old;
        return buildSyncedDecorations(newState.doc, allKnownSyncedIds());
      },
    },
    props: {
      decorations(state) {
        return syncedIndicatorPluginKey.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

/** Call after any `synced-store.ts` mutation so the badge reflects it without waiting for the next doc edit. */
export function refreshSyncedIndicators(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(syncedIndicatorPluginKey, "refresh"));
}

export const SyncedIndicatorExtension = Extension.create({
  name: "syncedIndicator",
  addProseMirrorPlugins() {
    return [createSyncedIndicatorPlugin()];
  },
});
