import { open } from "@tauri-apps/plugin-dialog";
import { useBibliotecaStore } from "./store";

interface ImportarLivroButtonProps {
  /** "painel": botão discreto no rodapé do painel, mesma forma de "Novo baralho". "destaque": botão primário grande, para a estante vazia. */
  variante: "painel" | "destaque";
}

/**
 * O único caminho de trazer um livro para a Biblioteca — usado no rodapé do
 * painel e de novo na estante vazia (a tarefa pede a ação de importar "em
 * evidência" no primeiro estado que o usuário vê). Um componente só para as
 * duas: o diálogo de arquivo, o "usuário cancelou" e o guard contra clique
 * duplo enquanto importa vivem aqui uma vez, não duas.
 *
 * Não fecha o próprio erro: `errorMessage` fica na store, e quem renderiza a
 * store (`PainelDeBiblioteca` hoje) decide onde mostrar.
 */
export function ImportarLivroButton({ variante }: ImportarLivroButtonProps) {
  const importando = useBibliotecaStore((state) => state.importando);
  const importar = useBibliotecaStore((state) => state.importar);

  async function handleClick() {
    const selecionado = await open({
      title: "Selecionar PDF ou EPUB",
      filters: [{ name: "PDF e EPUB", extensions: ["pdf", "epub"] }],
    });

    // Usuário fechou o diálogo sem escolher nada — não é erro, só nada a fazer.
    if (typeof selecionado !== "string") return;

    try {
      await importar(selecionado);
    } catch {
      // Erro já está em `errorMessage`; a store rejeita só para quem quiser
      // reagir localmente (nenhum caso ainda), este botão não precisa de mais.
    }
  }

  const rotulo = importando ? "Importando…" : "Importar livro…";

  if (variante === "destaque") {
    return (
      <button
        type="button"
        disabled={importando}
        onClick={() => void handleClick()}
        className="rounded-sm bg-emerald px-6 py-3 text-sm font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
      >
        {rotulo}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={importando}
      onClick={() => void handleClick()}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-muted
        transition-transform hover:bg-surface-sunken/60 hover:text-ink active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
    >
      <span aria-hidden="true">+</span> {rotulo}
    </button>
  );
}
