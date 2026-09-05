/**
 * The five `FormattingMenuItem`s for the marks in `marks.ts`, and the one
 * button component they share. `register.ts` wires each render function into
 * `registerFormattingMenuItem` - split into its own `.tsx` file because
 * `register.ts` must stay a plain `.ts` (the `discover-extensions.ts` glob
 * only looks for `register.ts`, and JSX needs a `.tsx` file to parse).
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import type { ReactNode } from "react";
import "./basic-marks.css";

type MarkName = "bold" | "italic" | "strike" | "code" | "underline";

interface MarkFormattingButtonProps {
  editor: TiptapEditor;
  markName: MarkName;
  /** Accessible name - the glyph alone ("B", "I", "</>"...) is not one. */
  label: string;
  glyph: ReactNode;
  onToggle: (editor: TiptapEditor) => void;
}

/**
 * One toggle button in the selection toolbar. Reads its own active state via
 * `useEditorState` rather than trusting a re-render from outside - the
 * `BubbleMenu` this renders inside re-mounts on selection changes but does
 * not otherwise guarantee a re-render on every mark toggle.
 */
function MarkFormattingButton({ editor, markName, label, glyph, onToggle }: MarkFormattingButtonProps) {
  const isActive = useEditorState({
    editor,
    selector: ({ editor: current }) => current.isActive(markName),
  });

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isActive}
      data-mark={markName}
      className={`ed-mark-button${isActive ? " ed-mark-button--active" : ""}`}
      // Toggling a mark must not steal focus/selection from the editor -
      // without this the mousedown itself collapses the selection before
      // `onClick`'s `toggleBold()` (etc.) ever runs, so nothing selected
      // gets formatted.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onToggle(editor)}
    >
      {glyph}
    </button>
  );
}

/** EDT-035: Ctrl/Cmd+B, or `**texto**`, toggles bold. */
export function renderBoldButton(editor: TiptapEditor): ReactNode {
  return (
    <MarkFormattingButton
      editor={editor}
      markName="bold"
      label="Negrito"
      glyph="B"
      onToggle={(current) => current.chain().focus().toggleBold().run()}
    />
  );
}

/** EDT-036: Ctrl/Cmd+I toggles italic. */
export function renderItalicButton(editor: TiptapEditor): ReactNode {
  return (
    <MarkFormattingButton
      editor={editor}
      markName="italic"
      label="Itálico"
      glyph="I"
      onToggle={(current) => current.chain().focus().toggleItalic().run()}
    />
  );
}

/** EDT-038: Ctrl/Cmd+Shift+S, or `~texto~`, toggles strikethrough. */
export function renderStrikeButton(editor: TiptapEditor): ReactNode {
  return (
    <MarkFormattingButton
      editor={editor}
      markName="strike"
      label="Riscado"
      glyph="S"
      onToggle={(current) => current.chain().focus().toggleStrike().run()}
    />
  );
}

/** EDT-039: Ctrl/Cmd+E toggles inline code. */
export function renderCodeButton(editor: TiptapEditor): ReactNode {
  return (
    <MarkFormattingButton
      editor={editor}
      markName="code"
      label="Código"
      glyph="</>"
      onToggle={(current) => current.chain().focus().toggleCode().run()}
    />
  );
}

/** No Fase 2 checklist item of its own - registered anyway, see `register.ts`. */
export function renderUnderlineButton(editor: TiptapEditor): ReactNode {
  return (
    <MarkFormattingButton
      editor={editor}
      markName="underline"
      label="Sublinhado"
      glyph="U"
      onToggle={(current) => current.chain().focus().toggleUnderline().run()}
    />
  );
}
