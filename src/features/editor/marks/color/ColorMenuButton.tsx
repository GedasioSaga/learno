/**
 * The single `FormattingMenuItem` this folder registers: one trigger button
 * that opens a small palette with two independent groups - text color
 * (EDT-040, the `color`/`textStyle` mark) and background highlight
 * (EDT-041, the separate `highlight` mark). Two groups because the task is
 * explicit that these are two different marks, never the same one renamed.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { HIGHLIGHT_COLORS, TEXT_COLORS, type NamedColor } from "./palette";

interface ColorMenuButtonProps {
  editor: TiptapEditor;
}

/** A single swatch button - `aria-label` carries the color's name because a colored circle alone communicates nothing to a screen reader or a color-blind reader. */
function ColorSwatch({
  color,
  active,
  labelSuffix,
  onPick,
}: {
  color: NamedColor;
  active: boolean;
  labelSuffix: string;
  onPick: (value: string) => void;
}) {
  return (
    <button
      type="button"
      className="ed-color-menu__swatch"
      style={{ backgroundColor: color.value }}
      aria-label={`${color.label}${labelSuffix}`}
      aria-pressed={active}
      onClick={() => onPick(color.value)}
    >
      {/* Active state as text, not just the swatch's own border - color is never the only signal (see module doc). */}
      {active ? "✓" : ""}
    </button>
  );
}

export function ColorMenuButton({ editor }: ColorMenuButtonProps) {
  const [open, setOpen] = useState(false);
  // Bumped on every editor transaction so the ✓ on an active swatch tracks
  // the real selection instead of freezing at whatever it was when this
  // button last happened to re-render for some unrelated reason.
  const [, forceRerender] = useState(0);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onTransaction = () => forceRerender((count) => count + 1);
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  // A palette left open after the user has clicked elsewhere just sits in
  // the way of the next selection - close it on any outside interaction.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      // `Event.target` is typed `EventTarget | null` because it's shared by
      // every event kind (including non-DOM ones); a real DOM `pointerdown`
      // dispatched by the browser always targets a `Node`, so this narrows a
      // type the DOM lib leaves too loose rather than working around a
      // genuine unknown.
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const applyTextColor = useCallback(
    (value: string | null) => {
      const chain = editor.chain().focus();
      if (value) chain.setColor(value).run();
      else chain.unsetColor().run();
      setOpen(false);
    },
    [editor],
  );

  const applyHighlight = useCallback(
    (value: string | null) => {
      const chain = editor.chain().focus();
      if (value) chain.setHighlight({ color: value }).run();
      else chain.unsetHighlight().run();
      setOpen(false);
    },
    [editor],
  );

  return (
    <div className="ed-color-menu" ref={containerRef}>
      <button
        type="button"
        className="ed-color-menu__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Cor do texto e destaque"
        onClick={() => setOpen((value) => !value)}
      >
        A
      </button>
      {open && (
        <div id={panelId} className="ed-color-menu__panel">
          <div role="group" aria-label="Cor do texto" className="ed-color-menu__group">
            <span className="ed-color-menu__group-label">Cor do texto</span>
            <div className="ed-color-menu__swatches">
              {TEXT_COLORS.map((color) => (
                <ColorSwatch
                  key={color.id}
                  color={color}
                  labelSuffix=""
                  active={editor.isActive("textStyle", { color: color.value })}
                  onPick={applyTextColor}
                />
              ))}
              <button type="button" className="ed-color-menu__clear" aria-label="Remover cor" onClick={() => applyTextColor(null)}>
                Remover cor
              </button>
            </div>
          </div>
          <div role="group" aria-label="Cor de fundo" className="ed-color-menu__group">
            <span className="ed-color-menu__group-label">Cor de fundo</span>
            <div className="ed-color-menu__swatches">
              {HIGHLIGHT_COLORS.map((color) => (
                <ColorSwatch
                  key={color.id}
                  color={color}
                  labelSuffix=" (fundo)"
                  active={editor.isActive("highlight", { color: color.value })}
                  onPick={applyHighlight}
                />
              ))}
              <button
                type="button"
                className="ed-color-menu__clear"
                aria-label="Remover destaque"
                onClick={() => applyHighlight(null)}
              >
                Remover destaque
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
