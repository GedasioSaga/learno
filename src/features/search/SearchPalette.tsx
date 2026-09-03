import { useCallback, useEffect, useId, useState, type KeyboardEvent } from "react";
import { EmptyState } from "../../components/EmptyState";
import type { SearchResult } from "../../lib/ipc";
import { useGlobalSearchShortcut } from "./useGlobalSearchShortcut";
import { useSearchResults } from "./useSearchResults";

interface SearchPaletteProps {
  /**
   * Chamado quando o usuário escolhe um resultado. A navegação de fato (abrir
   * a página) é responsabilidade de quem monta a árvore de páginas — a
   * paleta só sabe que uma escolha aconteceu, e fecha a si mesma depois.
   */
  onNavigate?: (pageId: string) => void;
}

const MATCH_KIND_LABEL: Record<SearchResult["match_kind"], string> = {
  title: "título",
  content: "conteúdo",
};

/**
 * FUN-037: paleta de busca global. `role="combobox"`/`listbox` em vez de um
 * `<select>`/`<datalist>` nativo porque nenhum dos dois suporta o que a
 * paleta precisa (linha com subtítulo, realce de item ativo por teclado sem
 * mover o foco do campo) — é o padrão ARIA "Combobox with List Autocomplete"
 * da WAI-ARIA APG, não ARIA por preferência estética.
 */
export function SearchPalette({ onNavigate }: SearchPaletteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputId = useId();
  const listboxId = useId();

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  useGlobalSearchShortcut(open);

  const { status, results, errorMessage } = useSearchResults(isOpen ? query : "");

  // Volta ao primeiro resultado sempre que a lista muda — evita que o realce
  // fique preso num índice que não existe mais numa lista mais curta.
  useEffect(() => {
    setActiveIndex(0);
  }, [results]);

  const selectResult = useCallback(
    (result: SearchResult) => {
      onNavigate?.(result.page_id);
      close();
    },
    [onNavigate, close],
  );

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const active = results[activeIndex];
      if (active) {
        event.preventDefault();
        selectResult(active);
      }
    }
  }

  if (!isOpen) return null;

  const trimmedQuery = query.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 px-4 pt-[15vh]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Busca global"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="w-full max-w-lg rounded-sm border border-border bg-surface shadow-hard"
      >
        <div className="border-b border-border p-3">
          <label htmlFor={inputId} className="sr-only">
            Buscar páginas
          </label>
          <input
            id={inputId}
            type="text"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Buscar em todas as páginas…"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={
              results[activeIndex] ? `${listboxId}-${activeIndex}` : undefined
            }
            className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-muted"
          />
        </div>

        <div className="max-h-80 overflow-y-auto p-2">
          {status === "error" && (
            <p role="alert" className="px-2 py-3 text-sm text-terracotta-ink">
              {errorMessage}
            </p>
          )}

          {status !== "error" && trimmedQuery === "" && (
            <EmptyState
              title="Busque em qualquer página"
              description="Digite um título ou trecho do conteúdo para começar."
            />
          )}

          {status !== "error" &&
            trimmedQuery !== "" &&
            status !== "loading" &&
            results.length === 0 && (
              <EmptyState
                title="Nada encontrado"
                description={`Nenhuma página bate com "${trimmedQuery}".`}
              />
            )}

          {results.length > 0 && (
            <ul id={listboxId} role="listbox" aria-label="Resultados da busca" className="flex flex-col gap-0.5">
              {results.map((result, index) => (
                <li
                  key={`${result.match_kind}-${result.page_id}-${index}`}
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                >
                  <button
                    type="button"
                    // `tabIndex={-1}`: o foco fica no campo o tempo todo (padrão
                    // combobox); isto só existe para o clique do mouse escolher.
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectResult(result)}
                    className={`flex w-full flex-col items-start gap-0.5 rounded-sm px-3 py-2 text-left ${
                      index === activeIndex ? "bg-surface-sunken" : ""
                    }`}
                  >
                    <span className="text-sm font-medium text-ink">{result.page_title}</span>
                    <span className="text-xs text-ink-muted">
                      {MATCH_KIND_LABEL[result.match_kind]} · {result.snippet}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {status === "loading" && <p className="px-3 py-2 text-xs text-ink-muted">Buscando…</p>}
        </div>
      </div>
    </div>
  );
}
