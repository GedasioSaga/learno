/**
 * Public surface of the block editor. Everything else under this folder
 * (`core/**`, plus `marks/`, `blocks/`, `interaction/`, `synced/` as other
 * builders add them) is an implementation detail - import from here, not
 * from a path inside it. See `README.md` for how to extend the editor
 * without touching any file this barrel re-exports from.
 */
export { Editor } from "./core/Editor";
export { registerBlockExtension } from "./core/registry";
export {
  collectBlockSpecs,
  collectEditorOverlays,
  collectFormattingMenuItems,
  collectSlashMenuItems,
  collectTurnIntoItems,
  inlinePlainTextFor,
  registerBlockSpec,
  registerEditorOverlay,
  registerInlinePlainText,
  registerFormattingMenuItem,
  registerSlashMenuItem,
  registerTurnIntoItem,
  resetBlockRegistriesForTests,
  specForBlockType,
  specForNodeName,
} from "./core/block-spec";
export type {
  BlockSpec,
  BlockSpecSerialization,
  EditorOverlay,
  InlinePlainText,
  FormattingMenuItem,
  SlashMenuItem,
  TurnIntoItem,
} from "./core/block-spec";
export {
  clearSlashQuery,
  contentDepthOf,
  currentBlockNode,
  insertBlockHere,
  turnCurrentBlockInto,
} from "./core/commands";
export { BLOCK_CONTENT_GROUP, NODE_NAMES, isBlockContentType } from "./core/node-names";
export { pageIdOf } from "./core/page-context";
export { blocksApi, whenBlockWritesSettle } from "./core/blocks-api";
export { newBlockId } from "./core/ids";
export { blocksToDoc, docToFlatBlocks } from "./core/serialize";
export type { FlatBlock } from "./core/serialize";
export type {
  Block,
  BlockChange,
  BlockCommands,
  BlockContent,
  BlockId,
  BlockPatch,
  BlockPlacement,
  NewBlock,
  PageId,
} from "./contract";
