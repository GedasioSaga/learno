/**
 * EDT-049: "Turn into" - convert the block under the cursor into a
 * different structural type without losing its text, marks or nested
 * children. `core/core-specs.ts` already registers the nine structural
 * types' `TurnIntoItem`s (via `registerTurnIntoItem`, run by
 * `turnCurrentBlockInto` in `core/commands.ts`, which is the primitive that
 * actually preserves id/text/children - see its own doc comment). This file
 * is only the UI that reaches it: a handle in the block's left gutter,
 * listing `collectTurnIntoItems()`.
 *
 * DOM/CSS contract for `interaction/drag/` (EDT-050/051), which needs a
 * handle in the same gutter:
 * - This handle is a `Decoration.Widget` anchored at the position right
 *   before the block's `blockContent` node starts (`$from.before(depth)` in
 *   `blockGutterAnchor` below) - that position's DOM parent is the `Block`
 *   wrapper (`.ed-block-wrapper`, see `core/schema.ts`), so the widget lands
 *   as a **sibling**, first child of the wrapper, right before the block's
 *   own content `<div>`. It never mounts inside that content div.
 * - It exists only for the block currently holding the selection - not
 *   every block in the document (see `blockGutterAnchor`) - and is removed
 *   the moment the selection leaves that block.
 * - The one DOM node this builder owns is the `<div data-block-handle="turn-into">`
 *   holding the trigger button (`data-testid="block-handle-turn-into"`).
 *   Its own CSS (`turn-into-handle.css`) makes `.ed-block-wrapper` a
 *   `position: relative` anchor (a rule any other sibling widget can rely
 *   on too - re-declaring `position: relative` on the same selector from a
 *   second stylesheet is a no-op, not a conflict) and positions this handle
 *   at `left: -1.6rem`, `width: 1.3rem`. A drag handle can register its own
 *   `Decoration.Widget` at the exact same `pos` (ProseMirror renders
 *   multiple widgets at one position as ordinary sibling DOM nodes - no
 *   shared container to coordinate) and position itself further out, e.g.
 *   `left: -3.1rem`, so the two sit side by side without either file
 *   importing the other.
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { Decoration, Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { collectTurnIntoItems, type TurnIntoItem } from "../../core/block-spec";
import { BLOCK_NODE_NAMES } from "../../core/node-names";

/** The contract's data-attribute (see this file's header) - element, not color, marks the handle for tests and for the drag builder. */
export const TURN_INTO_HANDLE_ATTRIBUTE = "data-block-handle";
export const TURN_INTO_HANDLE_VALUE = "turn-into";
/** Stable test id for the trigger button - what `getByTestId` in a test, or the drag builder's own code, should look for. */
export const TURN_INTO_HANDLE_TESTID = "block-handle-turn-into";
/** EDT-049's own reach-by-keyboard requirement: opens the handle's menu for whichever block currently holds the selection. */
export const TURN_INTO_SHORTCUT = "Mod-Alt-t";

interface GutterAnchor {
  /** Position right before the block's `blockContent` node - see this file's header for why that's also the wrapper's first-child slot. */
  pos: number;
  blockId: string;
}

/**
 * The block currently holding the selection, or `null` when the selection
 * isn't inside one (a `NodeSelection` on an atom like divider, or the doc
 * momentarily empty). Deliberately not `core/commands.ts`'s
 * `contentDepthOf` - that takes a live `Editor`, and `addDecorations`'s
 * `create` must read the `state` it's given, not `editor.state` (see the
 * warning on `DecorationCreateProps` in `@tiptap/core`) - so this is the
 * same small walk-up-the-depths logic against `state` directly.
 */
function blockGutterAnchor(state: EditorState): GutterAnchor | null {
  const { $from } = state.selection;
  // BLOCK_NODE_NAMES is typed narrower than a plain string array (see
  // node-names.ts); widened here the same way commands.ts's own
  // isBlockContentNode does, so `.includes` accepts the live node's name.
  const blockTypeNames = BLOCK_NODE_NAMES as readonly string[];
  for (let depth = $from.depth; depth >= 1; depth -= 1) {
    const node = $from.node(depth);
    if (!blockTypeNames.includes(node.type.name)) continue;
    const id = node.attrs.id;
    if (typeof id !== "string" || id.length === 0) return null;
    return { pos: $from.before(depth), blockId: id };
  }
  return null;
}

/** Moves the document's selection into the block this handle belongs to, so the menu's `isActive` checks and each item's `run` act on the block the user actually clicked - not wherever the caret happened to be left. */
function selectBlockAt(editor: TiptapEditor, anchorPos: number): void {
  // `anchorPos` is the position right before the blockContent node; +1
  // enters its content, the same "start of this block's text" position
  // `insertBlockHere`/`turnCurrentBlockInto` themselves expect the caret at.
  editor.commands.setTextSelection(anchorPos + 1);
}

function buildMenuItemButton(editor: TiptapEditor, closeMenu: () => void): (item: TurnIntoItem) => HTMLButtonElement {
  return (item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ed-block-handle__menu-item";
    button.setAttribute("role", "menuitemradio");
    // No `isActive` on an item is a legitimate "this type never marks itself
    // active" default (every core entry does provide one; a future builder's
    // entry isn't required to), not an error being papered over.
    const active = item.isActive?.(editor) ?? false;
    button.setAttribute("aria-checked", String(active));

    const mark = document.createElement("span");
    mark.className = "ed-block-handle__menu-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = active ? "✓" : "";

    const label = document.createElement("span");
    label.textContent = item.title;

    button.append(mark, label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      item.run(editor);
      closeMenu();
      editor.view.focus();
    });
    return button;
  };
}

/**
 * The handle's DOM, built once per block (see `Decoration.Widget`'s own
 * doc comment: `render` runs once on first mount, reused while the widget's
 * `key` - this block's id - stays the same). Vanilla DOM, not a React
 * subtree, matching this codebase's own convention for small interactive
 * markers inside the ProseMirror doc (`core/node-views.ts`'s todo checkbox
 * and toggle arrow) rather than mixing React portals into decorations.
 */
function renderHandle(editor: TiptapEditor, getPos: () => number | undefined): HTMLElement {
  const root = document.createElement("div");
  root.className = "ed-block-handle";
  root.setAttribute(TURN_INTO_HANDLE_ATTRIBUTE, TURN_INTO_HANDLE_VALUE);
  // Opts this whole subtree out of the surrounding contentEditable region -
  // the same reason `Divider`'s own renderHTML (schema.ts) sets this: a
  // button here must never become part of the document's editable text.
  root.setAttribute("contenteditable", "false");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "ed-block-handle__trigger";
  trigger.dataset.testid = TURN_INTO_HANDLE_TESTID;
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Transformar bloco em outro tipo");
  trigger.textContent = "⋮";

  const menu = document.createElement("div");
  menu.className = "ed-block-handle__menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Transformar em");
  menu.hidden = true;

  function onOutsideMouseDown(event: MouseEvent): void {
    // `event.target` on a MouseEvent is typed as `EventTarget | null` by
    // lib.dom - narrowed to `Node` here only for the `contains` check below,
    // which is exactly what `Node.contains` expects.
    const target = event.target as Node | null;
    if (target && root.contains(target)) return;
    closeMenu();
  }

  function closeMenu(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutsideMouseDown, true);
  }

  function openMenu(): void {
    const pos = getPos();
    if (pos === undefined) return; // widget detached mid-transaction - nothing to act on
    selectBlockAt(editor, pos);
    menu.replaceChildren(...collectTurnIntoItems().map(buildMenuItemButton(editor, closeMenu)));
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onOutsideMouseDown, true);
    const firstItem = menu.querySelector("button");
    firstItem?.focus();
  }

  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeMenu();
    trigger.focus();
  });

  // Without this, the browser's own mousedown handling moves the document
  // selection (into whatever text is nearest the click) before our click
  // listener runs - the same guard `node-views.ts`'s checkbox/arrow use.
  trigger.addEventListener("mousedown", (event) => event.preventDefault());
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  root.append(trigger, menu);
  return root;
}

export const TurnIntoBlockHandle = Extension.create({
  name: "turnIntoBlockHandle",
  addDecorations() {
    return {
      create: ({ state, editor }) => {
        const anchor = blockGutterAnchor(state);
        if (!anchor) return [];
        return [
          Decoration.Widget(anchor.pos, (_view: EditorView, getPos) => renderHandle(editor, getPos), {
            key: `turn-into-handle:${anchor.blockId}`,
            stopEvent: () => true,
          }),
        ];
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      // EDT-049's keyboard path: opens the same menu a click on the handle
      // opens, for whatever block the caret is already in - no mouse, no
      // hover, needed.
      [TURN_INTO_SHORTCUT]: () => {
        const trigger = this.editor.view.dom.querySelector<HTMLButtonElement>(
          `[data-testid="${TURN_INTO_HANDLE_TESTID}"]`,
        );
        if (!trigger) return false;
        trigger.click();
        return true;
      },
    };
  },
});
