/**
 * Registration point for EDT-045 (date mention): the node extension
 * (`date-mention-node.ts`, which already embeds its own "@" `Suggestion`)
 * plus the two overlays that draw UI on top of the editor - the suggestion
 * dropdown while typing, and the mini-calendar when an existing chip is
 * clicked. Three registrations because they're three different extension
 * points from `core/block-spec.ts`/`core/registry.ts` (items 1 and 5 of the
 * README), not because this builder has three separate features.
 *
 * `createElement`, not JSX: `discover-extensions.ts` only discovers files
 * literally named `register.ts` (a glob, not a regex), so this file can't be
 * `.tsx` - same reasoning documented in
 * `interaction/slash-menu/register.ts`.
 */
import { createElement } from "react";
import { registerEditorOverlay, registerInlinePlainText } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import { DateMentionCalendarOverlay } from "./DateMentionCalendarOverlay";
import { DateMentionSuggestionOverlay } from "./DateMentionSuggestionOverlay";
import { DateMention, MENTION_DATE_NODE_NAME } from "./date-mention-node";
import { formatDatePtBR } from "./date-parsing";

registerBlockExtension(DateMention);

// FUN-037: o chip só mostra "04/09/2026" na tela, mas attrs.date guarda
// "2026-09-04" - o usuário pode buscar por qualquer uma das duas formas, e
// só uma string com as duas separadas por espaço deixa as duas buscas
// acharem (um texto só pode ser "04/09/2026" OU "2026-09-04", não os dois).
registerInlinePlainText({
  nodeName: MENTION_DATE_NODE_NAME,
  text: (node) => {
    const iso = typeof node.attrs?.date === "string" ? node.attrs.date : null;
    const displayed = formatDatePtBR(iso);
    return [displayed, iso].filter((value): value is string => Boolean(value)).join(" ");
  },
});

registerEditorOverlay({
  id: "marks:mention-date-suggestion",
  render: (editor) => createElement(DateMentionSuggestionOverlay, { editor }),
});

registerEditorOverlay({
  id: "marks:mention-date-calendar",
  render: (editor) => createElement(DateMentionCalendarOverlay, { editor }),
});
