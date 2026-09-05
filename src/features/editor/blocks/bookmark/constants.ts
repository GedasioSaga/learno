/**
 * Persisted vocabulary (`Block.blockType`) and ProseMirror node name for
 * this block. Kept as named constants - not repeated string literals -
 * because `register.ts`, the node definition and the node view all need the
 * exact same string.
 */
export const BOOKMARK_BLOCK_TYPE = "bookmark";
export const BOOKMARK_NODE_NAME = "bookmark";
