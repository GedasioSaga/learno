/**
 * EDT-043: o painel do Ctrl/Cmd+K. Abre só quando há texto selecionado
 * dentro do editor - sem seleção, o mesmo atalho é a busca global (FUN-037,
 * `src/features/search/useGlobalSearchShortcut.ts`) e este componente
 * deixa o evento seguir intocado (sem `preventDefault`/`stopPropagation`)
 * para ela continuar recebendo. O listener fica no próprio nó DOM do editor
 * (`editor.view.dom`), não em `window`, porque é exatamente essa diferença
 * de alvo que separa "dentro do editor, com seleção" de "em qualquer outro
 * lugar da tela" - um listener em `window` não conseguiria diferenciar os
 * dois casos sem duplicar a lógica de foco que o DOM já resolve sozinho.
 *
 * `register.ts` só monta este componente via `registerEditorOverlay`; ele
 * fica sempre presente (mesmo fechado, retorna `null`) enquanto o editor
 * existir, exatamente como o próprio `Editor.tsx` já monta todo overlay
 * registrado.
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { parseLinkUrl } from "./link-url";

interface LinkOverlayProps {
  editor: TiptapEditor;
}

interface OverlayPosition {
  top: number;
  left: number;
}

const LINK_OVERLAY_VERTICAL_OFFSET_PX = 8;
const LINK_OVERLAY_ERROR_ID = "ed-link-overlay-error";

/** Onde ancorar o popup: logo abaixo do fim da seleção. */
function overlayPositionFor(editor: TiptapEditor): OverlayPosition {
  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.to);
    return { top: coords.bottom + LINK_OVERLAY_VERTICAL_OFFSET_PX, left: coords.left };
  } catch {
    // jsdom (ambiente de teste) não faz layout de verdade - `coordsAtPos`
    // pode não conseguir medir um retângulo. No browser real isso não
    // acontece; um popup em (0,0) ainda abre e funciona, só não fica
    // ancorado visualmente à seleção.
    return { top: 0, left: 0 };
  }
}

export function LinkOverlay({ editor }: LinkOverlayProps) {
  const [position, setPosition] = useState<OverlayPosition | null>(null);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dom = editor.view.dom;

    function handleKeyDown(event: KeyboardEvent) {
      const isShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (!isShortcut) return;
      // Sem seleção, Ctrl/Cmd+K continua sendo a busca global (FUN-037) -
      // deixa o evento subir até `window` sem tocar nele.
      if (editor.state.selection.empty) return;
      event.preventDefault();
      event.stopPropagation();
      setPosition(overlayPositionFor(editor));
      setValue("");
      setInvalid(false);
    }

    dom.addEventListener("keydown", handleKeyDown);
    return () => dom.removeEventListener("keydown", handleKeyDown);
  }, [editor]);

  // Foco no campo ao abrir (EDT-043) - roda depois do popup existir no DOM.
  useEffect(() => {
    if (position) inputRef.current?.focus();
  }, [position]);

  if (!position) return null;

  function closeOverlay() {
    setPosition(null);
    // O popup já apareceu ancorado à seleção (`overlayPositionFor`), então
    // não há para onde rolar a tela ao devolver o foco - `scrollIntoView:
    // false` evita um salto de viewport desnecessário no fechamento.
    editor.commands.focus(undefined, { scrollIntoView: false });
  }

  function applyLink() {
    const url = parseLinkUrl(value);
    if (!url) {
      setInvalid(true);
      return;
    }
    // O `href` também vira `title` - é o que dá o preview ao passar o mouse
    // (EDT-043): a marca `Link` já tem o atributo `title` pronto para
    // renderizar (`node_modules/@tiptap/extension-link`), só faltava alguém
    // preenchê-lo, e o tooltip nativo do browser sobre um `title` já resolve
    // "mostra a URL de destino" sem UI própria para isso.
    editor.chain().extendMarkRange("link").setLink({ href: url, title: url }).run();
    closeOverlay();
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOverlay();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      applyLink();
    }
  }

  return (
    <div
      className="ed-link-overlay"
      role="dialog"
      aria-label="Adicionar link"
      style={{ top: position.top, left: position.left }}
    >
      <input
        ref={inputRef}
        type="url"
        className="ed-link-overlay__input"
        aria-label="URL do link"
        aria-invalid={invalid}
        aria-describedby={invalid ? LINK_OVERLAY_ERROR_ID : undefined}
        placeholder="https://exemplo.com"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={handleInputKeyDown}
      />
      {invalid && (
        <p id={LINK_OVERLAY_ERROR_ID} className="ed-link-overlay__error" role="alert">
          URL inválida - use um endereço com esquema reconhecido (http://, https://, mailto:...).
        </p>
      )}
    </div>
  );
}
