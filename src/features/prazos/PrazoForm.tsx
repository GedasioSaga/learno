import { useEffect, useState, type FormEvent } from "react";
import { AppError, listDecks, type DeckRow } from "../../lib/ipc";
import type { PrazoRow } from "./ipc";
import { usePrazosStore } from "./store";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

interface PrazoFormProps {
  /** Presente = editando este prazo; ausente = criando um novo. */
  prazo?: PrazoRow;
  onFechar: () => void;
}

/**
 * Formulário de criar/editar prazo — título, data-limite e, só na criação,
 * um baralho opcional para ligar.
 *
 * Baralho não entra na EDIÇÃO de propósito: o patch do backend usa
 * `COALESCE` (ver o comentário de `PrazoPatchInput` em `./ipc.ts`) e não
 * existe caminho para limpar `deckId` de volta para `null` uma vez
 * preenchido. Oferecer o campo aqui e ele não conseguir "desligar" o
 * vínculo seria a tela afirmando uma capacidade que o dado não sustenta —
 * então o campo fica de fora da edição em vez de mentir. Ligar a um baralho
 * diferente do já escolhido continuaria tecnicamente possível no backend,
 * mas a mesma UI que não sabe limpar também não tenta trocar; é a mesma
 * decisão que `features/cronograma/NovoBlocoForm.tsx` já tomou (deixar
 * baralho/página de fora por ora).
 */
export function PrazoForm({ prazo, onFechar }: PrazoFormProps) {
  const criar = usePrazosStore((state) => state.criar);
  const atualizar = usePrazosStore((state) => state.atualizar);

  const [titulo, setTitulo] = useState(prazo?.title ?? "");
  const [dueLocalDate, setDueLocalDate] = useState(prazo?.dueLocalDate ?? "");
  const [deckId, setDeckId] = useState("");
  const [decks, setDecks] = useState<DeckRow[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    // Só a criação usa a lista de baralhos (ver o comentário do componente);
    // buscar mesmo assim na edição não tem custo real e evita duplicar este
    // efeito num componente separado.
    let cancelado = false;
    listDecks()
      .then((lista) => {
        if (!cancelado) setDecks(lista);
      })
      .catch(() => {
        // Baralho é um vínculo opcional: sem a lista, o seletor some — não é
        // um erro que deva travar o formulário inteiro de criar um prazo.
      });
    return () => {
      cancelado = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tituloAparado = titulo.trim();
    if (tituloAparado === "") {
      setErro("Título não pode ficar vazio.");
      return;
    }
    if (dueLocalDate.trim() === "") {
      setErro("Escolha uma data.");
      return;
    }

    setSalvando(true);
    setErro(null);
    try {
      if (prazo) {
        await atualizar(prazo.id, { title: tituloAparado, dueLocalDate });
      } else {
        await criar(tituloAparado, dueLocalDate, deckId === "" ? null : deckId);
      }
      onFechar();
    } catch (error) {
      setErro(messageFor(error, prazo ? "Não foi possível salvar o prazo." : "Não foi possível criar o prazo."));
      setSalvando(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      aria-label={prazo ? "Editar prazo" : "Novo prazo"}
      className="flex flex-col gap-1.5 rounded-sm border border-border bg-paper p-3"
    >
      <label className="text-xs">
        <span className="mb-0.5 block text-ink-muted">Título</span>
        <input
          value={titulo}
          onChange={(event) => setTitulo(event.currentTarget.value)}
          className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-xs text-ink"
        />
      </label>

      <label className="text-xs">
        <span className="mb-0.5 block text-ink-muted">Data-limite</span>
        <input
          type="date"
          value={dueLocalDate}
          onChange={(event) => setDueLocalDate(event.currentTarget.value)}
          className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-xs text-ink"
        />
      </label>

      {!prazo && decks.length > 0 ? (
        <label className="text-xs">
          <span className="mb-0.5 block text-ink-muted">Baralho (opcional)</span>
          <select
            value={deckId}
            onChange={(event) => setDeckId(event.currentTarget.value)}
            className="w-full rounded-sm border border-border bg-paper px-2 py-1 text-xs text-ink"
          >
            <option value="">Nenhum</option>
            {decks.map((deck) => (
              <option key={deck.id} value={deck.id}>
                {deck.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {erro ? (
        <p role="alert" className="text-xs text-terracotta-ink">
          {erro}
        </p>
      ) : null}

      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onFechar}
          className="rounded-sm px-2 py-1 text-xs text-ink-muted transition duration-150 ease-out motion-reduce:transition-none hover:text-ink"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={salvando}
          className="rounded-sm bg-emerald px-2.5 py-1 text-xs font-medium text-on-emerald transition duration-150 ease-out motion-reduce:transition-none hover:brightness-110 active:scale-97 disabled:opacity-50"
        >
          {salvando ? "Salvando…" : prazo ? "Salvar" : "Criar"}
        </button>
      </div>
    </form>
  );
}
