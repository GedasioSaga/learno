/**
 * EDT-040 (cor de texto) / EDT-041 (cor de fundo). Two genuinely different
 * marks - `textStyle`+`color` for the font, `highlight` for the background -
 * not one mark wearing two names, per the task's explicit requirement.
 *
 * No `BlockSpec` here on purpose: a mark isn't a block type, and its attrs
 * ride inside whatever block's `content.inline` array already carries text
 * marks - `serialize.ts`'s default `content()`/`nodeContent()` (a plain
 * `{ inline: nodeContent }` passthrough) already round-trips it, so nothing
 * needs registering beyond the extensions themselves (see the README's
 * "Marcas de texto" paragraph).
 *
 * Kept as a plain `.ts` module (no JSX) so `import.meta.glob`'s literal
 * `register.ts` pattern in `discover-extensions.ts` still matches it - the
 * actual UI lives in `ColorMenuButton.tsx`, a proper JSX file this one just
 * wires in via `createElement`.
 */
import { createElement } from "react";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import { registerFormattingMenuItem } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import { ColorMenuButton } from "./ColorMenuButton";
import "./color.css";

registerBlockExtension([
  TextStyle,
  Color,
  // `multicolor: true` is what lets `attrs.color` vary per mark instance -
  // without it every highlight in the document would be forced to one fixed
  // color, which defeats EDT-041's own palette.
  Highlight.configure({ multicolor: true }),
]);

registerFormattingMenuItem({
  id: "marks:color",
  order: 20,
  render: (editor) => createElement(ColorMenuButton, { editor }),
});
