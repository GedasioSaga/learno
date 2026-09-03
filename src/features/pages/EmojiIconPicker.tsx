import { useId, useRef, useState, type FormEvent } from "react";
import { usePageTreeStore } from "./store";
import { hidePopoverSafely } from "./dom-compat";
import { useOpenTransition } from "./use-open-transition";

interface EmojiIconPickerProps {
  pageId: string;
  currentIcon: string | null;
  /** Rótulo acessível do botão-gatilho — muda conforme onde o seletor mora (linha da árvore vs. cabeçalho da página). */
  triggerLabel: string;
}

// Um recorte pequeno e útil para estudo, não uma paleta completa — o campo de
// texto logo abaixo aceita qualquer emoji digitado ou colado, então esta
// grade é atalho, não limite.
const CURATED_EMOJIS = [
  "📄", "📚", "📝", "📖", "🧠", "🔬", "🧪", "📐",
  "🧮", "🌍", "💡", "🎯", "✅", "⭐", "🗂️", "📌",
];

/**
 * FUN-011. `popover="auto"` dá de graça o que a UI de um seletor precisa:
 * fechar ao clicar fora, fechar com Escape, e renderizar acima de tudo sem a
 * barra lateral (que tem `overflow-y-auto`) cortar o painel — sem nenhum
 * listener de clique-fora escrito à mão.
 */
export function EmojiIconPicker({ pageId, currentIcon, triggerLabel }: EmojiIconPickerProps) {
  const panelId = useId();
  const setIcon = usePageTreeStore((state) => state.setIcon);
  const [customValue, setCustomValue] = useState("");
  const [open, setOpen] = useState(false);
  const entered = useOpenTransition(open);
  const panelRef = useRef<HTMLDivElement>(null);

  async function choose(icon: string | null) {
    await setIcon(pageId, icon);
    hidePopoverSafely(panelRef.current);
  }

  function handleCustomSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = customValue.trim();
    if (trimmed === "") return;
    void choose(trimmed);
    setCustomValue("");
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        popoverTarget={panelId}
        popoverTargetAction="toggle"
        aria-label={triggerLabel}
        className="grid size-6 shrink-0 place-items-center rounded-sm text-base leading-none transition-transform active:scale-97"
      >
        {currentIcon ?? "📄"}
      </button>

      <div
        id={panelId}
        ref={panelRef}
        popover="auto"
        onToggle={(event) => setOpen(event.newState === "open")}
        // `transform-origin: top left` (via `origin-top-left`) porque o
        // gatilho fica no canto superior-esquerdo do painel: a entrada tem
        // que crescer a partir de onde o usuário clicou, não do centro.
        className={`absolute left-0 top-full m-0 mt-1 w-56 origin-top-left rounded-md border border-border
          bg-surface p-3 shadow-hard transition duration-150 ease-out motion-reduce:transition-none
          ${entered ? "scale-100 opacity-100" : "scale-95 opacity-0"}`}
      >
        <p className="text-xs font-medium text-ink-muted">Ícone da página</p>
        <div className="mt-2 grid grid-cols-8 gap-1">
          {CURATED_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => void choose(emoji)}
              aria-label={`Escolher ícone ${emoji}`}
              className="grid size-6 place-items-center rounded-sm text-base leading-none transition-transform hover:bg-surface-sunken active:scale-90"
            >
              {emoji}
            </button>
          ))}
        </div>

        <form className="mt-3 flex gap-2" onSubmit={handleCustomSubmit}>
          <label className="sr-only" htmlFor={`${panelId}-custom`}>
            Outro emoji
          </label>
          <input
            id={`${panelId}-custom`}
            value={customValue}
            onChange={(event) => setCustomValue(event.currentTarget.value)}
            placeholder="Colar outro emoji"
            className="w-full min-w-0 rounded-sm border border-border bg-paper px-2 py-1 text-sm text-ink"
          />
          <button
            type="submit"
            className="shrink-0 rounded-sm border border-border px-2 py-1 text-xs font-medium text-ink"
          >
            Usar
          </button>
        </form>

        {currentIcon ? (
          <button
            type="button"
            onClick={() => void choose(null)}
            className="mt-2 text-xs text-ink-muted underline underline-offset-2"
          >
            Remover ícone
          </button>
        ) : null}
      </div>
    </span>
  );
}
