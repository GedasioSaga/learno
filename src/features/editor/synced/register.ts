/**
 * Wires EDT-073/074/076/077/078 together. Discovered automatically by
 * `core/discover-extensions.ts`'s `import.meta.glob`; nothing imports this
 * file directly.
 */
import { registerEditorOverlay, registerFormattingMenuItem, registerSlashMenuItem, registerTurnIntoItem } from "../core/block-spec";
import { registerBlockExtension } from "../core/registry";
import { renderDeleteSyncedOriginalDialog } from "./DeleteSyncedOriginalDialog";
import { renderSyncedControls } from "./SyncedControls";
import { LiveMirrorExtension } from "./live-mirror-extension";
import { SyncedIndicatorExtension } from "./synced-decorations";
import { isCurrentBlockSyncedOrigin, markCurrentBlockAsSyncedOrigin, pasteSyncedCopyFromClipboard } from "./synced-actions";

registerBlockExtension([SyncedIndicatorExtension, LiveMirrorExtension]);

// EDT-073: "Turn into > Bloco sincronizado". Preserves the block's own type
// and text - unlike most `TurnIntoItem`s (paragraph -> heading), this one
// never calls `turnCurrentBlockInto`, it only declares the block a synced
// origin (see `synced-actions.ts`'s doc comment on why there's no node-type
// change and no backend call here).
registerTurnIntoItem({
  id: "synced:turn-into",
  title: "Bloco sincronizado",
  group: "Sincronizado",
  icon: "🔗",
  run: markCurrentBlockAsSyncedOrigin,
  isActive: isCurrentBlockSyncedOrigin,
});

// EDT-076/077/078: shown only for a block this browser knows is part of a
// synced group - `renderSyncedControls` itself returns `null` otherwise.
registerFormattingMenuItem({ id: "synced:controls", order: 10, render: renderSyncedControls });

// EDT-073's other half: the "Copiar" button on an origin's toolbar
// (`SyncedControls.tsx`) only remembers a source id - this is what actually
// lands a copy, on whatever block/page the user opens the `/` menu on next.
// Listed even with nothing copied yet - `run` itself is the guard, same
// convention `blocks/page-link/register.ts`'s own `/` entries use for a
// missing `selectedPageId`.
registerSlashMenuItem({
  id: "synced:paste-copy",
  title: "Colar cópia sincronizada",
  keywords: ["synced", "sincronizado", "colar", "copia", "cópia"],
  group: "Sincronizado",
  icon: "🔗",
  run: (editor) => {
    void pasteSyncedCopyFromClipboard(editor).catch(() => undefined);
    return true;
  },
});

// EDT-078's confirmation dialog - invisible until `requestDeleteSyncedOriginal` opens it.
registerEditorOverlay({ id: "synced:delete-confirm-dialog", render: renderDeleteSyncedOriginalDialog });
