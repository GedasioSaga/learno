import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";
import { ThemeToggle } from "./ThemeToggle";

interface AppShellProps {
  children: ReactNode;
  /**
   * O que ocupa o `data-slot="page-tree"` — o estado vazio abaixo é só o
   * padrão para quem monta `AppShell` sem essa prop (como o teste deste
   * componente); `App.tsx` passa a árvore de páginas de verdade aqui.
   */
  sidebar?: ReactNode;
}

/** A casca da interface: barra lateral fixa à esquerda, conteúdo à direita. */
export function AppShell({ children, sidebar }: AppShellProps) {
  return (
    <div className="flex h-screen bg-paper text-ink">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface-sunken">
        <div className="flex items-center gap-2 border-b border-border px-4 py-4">
          <span aria-hidden="true" className="text-xl" style={{ imageRendering: "pixelated" }}>
            📚
          </span>
          <span className="font-display text-lg text-ink">Learno</span>
        </div>

        <nav
          aria-label="Páginas"
          data-slot="page-tree"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {sidebar ?? (
            <EmptyState
              title="Suas páginas aparecem aqui"
              description="A árvore de páginas ainda está sendo construída."
            />
          )}
        </nav>

        <div className="border-t border-border p-3">
          <ThemeToggle />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto" data-slot="content">
        {children}
      </main>
    </div>
  );
}
