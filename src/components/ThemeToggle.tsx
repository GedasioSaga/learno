import { useThemeStore } from "../lib/theme-store";

/**
 * Botão nativo simples: `<button>` já é focável e acionável por teclado sem
 * nenhum ARIA extra. `aria-pressed` é o único atributo a mais, porque isto é
 * mesmo um botão de alternância (estado ligado/desligado), não um botão comum.
 */
export function ThemeToggle() {
  const effective = useThemeStore((state) => state.effective);
  const toggle = useThemeStore((state) => state.toggle);
  const isDark = effective === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={isDark}
      className="flex w-full items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink shadow-hard-sm transition-transform hover:-translate-y-px active:translate-y-0 active:shadow-none"
    >
      <span aria-hidden="true">{isDark ? "🌙" : "☀️"}</span>
      {isDark ? "Tema escuro" : "Tema claro"}
    </button>
  );
}
