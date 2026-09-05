/**
 * The ProseMirror node name this builder's node renders as - a local
 * constant (not `core/node-names.ts`, which only lists the nine structural
 * types `core/schema.ts` owns) shared between the extension itself and its
 * NodeView so the string is typed exactly once.
 */
export const MENTION_PAGE_NODE_NAME = "mentionPage";
