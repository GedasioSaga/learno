/**
 * Registers the five basic inline marks (EDT-035/036/038/039 + underline) -
 * both the TipTap extension and its toolbar button, so they land on the
 * editor together. Discovered automatically by
 * `core/discover-extensions.ts`'s `import.meta.glob`; nothing imports this
 * file directly.
 */
import { registerFormattingMenuItem } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import {
  renderBoldButton,
  renderCodeButton,
  renderItalicButton,
  renderStrikeButton,
  renderUnderlineButton,
} from "./formatting-buttons";
import { basicMarkExtensions } from "./marks";

registerBlockExtension(basicMarkExtensions);

registerFormattingMenuItem([
  { id: "marks:bold", order: 0, render: renderBoldButton },
  { id: "marks:italic", order: 1, render: renderItalicButton },
  { id: "marks:strike", order: 2, render: renderStrikeButton },
  { id: "marks:code", order: 3, render: renderCodeButton },
  { id: "marks:underline", order: 4, render: renderUnderlineButton },
]);
