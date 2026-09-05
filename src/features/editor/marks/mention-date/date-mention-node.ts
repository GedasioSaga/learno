/**
 * EDT-045: an inline atom node - a date chip - triggered by "@" plus a
 * Portuguese relative term or a date format, the same trigger character the
 * page-mention builder (EDT-044/046) also owns. `@tiptap/suggestion` decides
 * WHEN a match is active; `shouldShow` below is what keeps this builder's
 * popup silent for a query that doesn't read as a date, so the two "@"
 * suggestions don't fight over every keystroke - see `date-parsing.ts`'s
 * `dateCandidatesFor` for the matching rule itself.
 *
 * `priority: 101` (matching `@tiptap/extension-mention`'s own real-world
 * value - `node_modules/@tiptap/extension-mention/src/mention.ts`) makes
 * this node's own plugins - including the `Suggestion` below's `Enter`
 * handling - run before `core/keymap.ts`'s `BlockKeymap` (default priority
 * 100), which would otherwise split the block on every Enter, including one
 * meant to confirm a suggestion.
 *
 * The popup itself (`DateMentionSuggestionOverlay.tsx`) and the mini-calendar
 * opened by clicking an existing chip (`DateMentionCalendarOverlay.tsx`) are
 * both `EditorOverlay`s registered from `register.ts`, not rendered here -
 * this file only owns the node and the trigger.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import type { Editor, NodeViewRendererProps, Range } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { PluginKey } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import { Suggestion } from "@tiptap/suggestion";
import { dateCandidatesFor, formatDatePtBR } from "./date-parsing";
import { useDateMentionCalendarStore } from "./date-mention-calendar-store";
import { useDateMentionSuggestionStore } from "./date-mention-suggestion-store";

export const MENTION_DATE_NODE_NAME = "mentionDate";
const MENTION_DATE_TRIGGER_CHAR = "@";
const MENTION_DATE_PRIORITY = 101;

/**
 * Own key, not the package's default `SuggestionPluginKey` singleton -
 * `interaction/slash-menu/slash-menu-extension.ts` documents the same
 * requirement for its own "/" trigger, and the page-mention builder shares
 * this exact "@" character, so colliding here would mean only one of the two
 * `Suggestion` plugins actually registers.
 */
export const mentionDateSuggestionPluginKey = new PluginKey("learno-mention-date-suggestion");

const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter"]);

/**
 * What both the popup's Enter key and its mouse click do: replace the
 * matched "@query" range with the chip, carrying the *resolved* ISO date in
 * `attrs.date` - never the text the user typed. Exported so
 * `DateMentionSuggestionOverlay.tsx`'s click path and this file's own
 * keyboard path never diverge, and so tests can drive an insertion directly
 * without going through real keystrokes.
 */
export function insertDateMention(editor: Editor, range: Range, iso: string): void {
  editor.chain().focus().insertContentAt(range, { type: MENTION_DATE_NODE_NAME, attrs: { date: iso } }).run();
}

class DateMentionNodeView implements NodeView {
  dom: HTMLElement;
  private node: PMNode;

  constructor({ node, getPos }: NodeViewRendererProps) {
    this.node = node;

    // A real <button>, not a styled <span> - HTML semântico primeiro
    // (README/regra 16): focável, anunciável e acionável por teclado sem
    // nenhum ARIA extra, mesma escolha que os NodeViews de `core/` fazem
    // para o checkbox do to-do e a seta do toggle.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ed-mention-date";
    button.setAttribute("data-type", MENTION_DATE_NODE_NAME);
    button.contentEditable = "false";
    button.addEventListener("mousedown", (event) => {
      // mousedown, não click: um click tiraria o foco/seleção do editor
      // antes do handler rodar - mesmo cuidado que
      // `interaction/slash-menu/SlashMenuOverlay.tsx` documenta para o seu
      // próprio clique de item.
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      const iso = typeof this.node.attrs.date === "string" ? this.node.attrs.date : null;
      useDateMentionCalendarStore.getState().open(pos, iso, button.getBoundingClientRect());
    });
    this.dom = button;
    this.syncLabel();
  }

  private syncLabel(): void {
    const iso = typeof this.node.attrs.date === "string" ? this.node.attrs.date : null;
    const label = formatDatePtBR(iso) || "Data";
    this.dom.textContent = label;
    this.dom.setAttribute(
      "aria-label",
      iso ? `Data mencionada: ${label}. Clique para editar.` : "Data mencionada sem valor. Clique para editar.",
    );
  }

  update(node: PMNode): boolean {
    if (node.type.name !== MENTION_DATE_NODE_NAME) return false;
    this.node = node;
    this.syncLabel();
    return true;
  }
}

function dateMentionNodeView(props: NodeViewRendererProps): NodeView {
  return new DateMentionNodeView(props);
}

export const DateMention = Node.create({
  name: MENTION_DATE_NODE_NAME,
  priority: MENTION_DATE_PRIORITY,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      date: {
        // Widens the literal `null` so TS infers `string | null` for the
        // attr, not `null` - same idiom `core/schema.ts`'s `idAttribute`
        // uses for its own `id` attribute.
        default: null as string | null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-date"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.date === "string" ? { "data-date": attributes.date } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-type="${MENTION_DATE_NODE_NAME}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const iso = typeof node.attrs.date === "string" ? node.attrs.date : null;
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-type": MENTION_DATE_NODE_NAME, class: "ed-mention-date" }),
      formatDatePtBR(iso) || "Data",
    ];
  },

  addNodeView() {
    return dateMentionNodeView;
  },

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      Suggestion({
        editor,
        pluginKey: mentionDateSuggestionPluginKey,
        char: MENTION_DATE_TRIGGER_CHAR,
        // The one thing this builder adds beyond the slash-menu's own
        // `Suggestion` usage: staying silent for a query that isn't a date,
        // instead of always showing (and fighting the page-mention popup on
        // the same "@").
        shouldShow: ({ query }) => dateCandidatesFor(query, new Date()).length > 0,
        render: () => ({
          onStart: (props) => {
            useDateMentionSuggestionStore.getState().open(props.query, props.clientRect?.() ?? null, props.range);
          },
          onUpdate: (props) => {
            useDateMentionSuggestionStore.getState().update(props.query, props.clientRect?.() ?? null, props.range);
          },
          onExit: () => {
            useDateMentionSuggestionStore.getState().close();
          },
          onKeyDown: ({ event, range }) => {
            if (!NAVIGATION_KEYS.has(event.key)) return false;
            const { query, highlightedId } = useDateMentionSuggestionStore.getState();
            const candidates = dateCandidatesFor(query, new Date());
            if (candidates.length === 0) return true;

            if (event.key === "Enter") {
              event.preventDefault();
              const target = candidates.find((candidate) => candidate.id === highlightedId) ?? candidates[0];
              insertDateMention(editor, range, target.iso);
              useDateMentionSuggestionStore.getState().close();
              return true;
            }

            const currentIndex = candidates.findIndex((candidate) => candidate.id === highlightedId);
            const step = event.key === "ArrowDown" ? 1 : -1;
            const nextIndex = (currentIndex + step + candidates.length) % candidates.length;
            useDateMentionSuggestionStore.getState().setHighlightedId(candidates[nextIndex].id);
            return true;
          },
        }),
      }),
    ];
  },
});
