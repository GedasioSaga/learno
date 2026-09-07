import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AppError, createNote, type NoteFieldValues } from "../../lib/ipc";
import { useCartoesStore } from "./store";
import { flattenAllDecks } from "./tree-utils";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * A tela "Criar cartão": baralho e tipo de nota no topo, os campos do tipo
 * escolhido empilhados embaixo (Frente/Verso, no tipo mais comum), etiquetas
 * por último — o mesmo arranjo da captura do Anki que o usuário mandou.
 *
 * Depois de salvar, o formulário limpa só os campos (não o baralho nem o
 * tipo escolhidos): criar vários cartões seguidos no mesmo baralho é o uso
 * real desta tela, e reescolher os dois topos a cada cartão seria o tipo de
 * atrito que o Anki não tem.
 */
export function CriarCartao() {
  const childrenIndex = useCartoesStore((state) => state.childrenIndex);
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);
  const noteTypes = useCartoesStore((state) => state.noteTypes);
  const noteTypesStatus = useCartoesStore((state) => state.noteTypesStatus);
  const loadNoteTypes = useCartoesStore((state) => state.loadNoteTypes);
  const irPara = useCartoesStore((state) => state.irPara);

  const decksAchatados = useMemo(() => flattenAllDecks(childrenIndex), [childrenIndex]);

  const [deckId, setDeckId] = useState<string | null>(deckSelecionadoId ?? decksAchatados[0]?.deck.id ?? null);
  const [noteTypeId, setNoteTypeId] = useState<string | null>(null);
  const [campos, setCampos] = useState<NoteFieldValues>({});
  const [tagsTexto, setTagsTexto] = useState("");
  const [status, setStatus] = useState<"idle" | "salvando" | "erro">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmacao, setConfirmacao] = useState<string | null>(null);

  useEffect(() => {
    void loadNoteTypes();
  }, [loadNoteTypes]);

  useEffect(() => {
    if (noteTypeId === null && noteTypes.length > 0) {
      setNoteTypeId(noteTypes[0].id);
    }
  }, [noteTypes, noteTypeId]);

  const tipoAtual = noteTypes.find((noteType) => noteType.id === noteTypeId) ?? null;

  // Trocar de tipo de nota reseta os campos preenchidos: os nomes de campo
  // do tipo anterior podem nem existir no novo.
  useEffect(() => {
    setCampos({});
  }, [noteTypeId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deckId || !tipoAtual) return;

    const preenchidos: NoteFieldValues = Object.fromEntries(
      tipoAtual.fields.map((nome) => [nome, campos[nome]?.trim() ?? ""]),
    );
    const temConteudo = Object.values(preenchidos).some((valor) => valor !== "");
    if (!temConteudo) {
      setErrorMessage("Preencha ao menos um campo.");
      return;
    }

    const tags = tagsTexto
      .split(/[,\s]+/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");

    setStatus("salvando");
    setErrorMessage(null);
    setConfirmacao(null);
    try {
      await createNote(deckId, tipoAtual.id, preenchidos, tags);
      setCampos({});
      setStatus("idle");
      setConfirmacao("Cartão criado.");
      // O baralho que acabou de ganhar um cartão novo tem "novos" desatualizado
      // no painel até este refresh — chamado direto na store (fora de um hook)
      // porque é uma reação a um evento, não uma assinatura de UI.
      void useCartoesStore.getState().refreshAllCounts();
    } catch (error) {
      setErrorMessage(messageFor(error, "Não foi possível criar o cartão."));
      setStatus("erro");
    }
  }

  if (decksAchatados.length === 0) {
    return (
      <div className="p-6">
        <p className="text-sm text-ink-muted">Crie um baralho antes de criar cartões.</p>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <button
        type="button"
        onClick={() => irPara("resumo")}
        className="self-start text-sm text-ink-muted transition-colors duration-150 ease-out hover:text-ink"
      >
        ← Voltar
      </button>

      <h2 className="font-display text-2xl text-ink">Criar cartão</h2>

      <div className="flex gap-3">
        <label className="flex-1 text-sm">
          <span className="mb-1 block text-ink-muted">Baralho</span>
          <select
            value={deckId ?? ""}
            onChange={(event) => setDeckId(event.currentTarget.value || null)}
            className="w-full rounded-sm border border-border bg-paper px-3 py-2 text-ink"
          >
            {decksAchatados.map(({ deck, depth }) => (
              <option key={deck.id} value={deck.id}>
                {"— ".repeat(depth)}
                {deck.name.trim() === "" ? "Sem nome" : deck.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex-1 text-sm">
          <span className="mb-1 block text-ink-muted">Tipo de nota</span>
          <select
            value={noteTypeId ?? ""}
            onChange={(event) => setNoteTypeId(event.currentTarget.value || null)}
            disabled={noteTypesStatus !== "ready" || noteTypes.length === 0}
            className="w-full rounded-sm border border-border bg-paper px-3 py-2 text-ink disabled:opacity-50"
          >
            {noteTypes.map((noteType) => (
              <option key={noteType.id} value={noteType.id}>
                {noteType.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {tipoAtual ? (
        <div className="flex flex-col gap-3">
          {tipoAtual.fields.map((nome) => (
            <label key={nome} className="text-sm">
              <span className="mb-1 block text-ink-muted">{nome}</span>
              <textarea
                value={campos[nome] ?? ""}
                onChange={(event) => {
                  // Lê `value` já aqui, fora do atualizador funcional: React
                  // zera `currentTarget` do evento sintético assim que a
                  // chamada síncrona do handler termina, e `setCampos` com
                  // uma função só roda de fato no próximo render.
                  const valor = event.currentTarget.value;
                  setCampos((atual) => ({ ...atual, [nome]: valor }));
                }}
                rows={3}
                // O `<span>` acima já dá nome visível via wrapping do `<label>`,
                // mas `aria-label` explícito é o que dá um seletor estável para
                // o e2e — o nome do campo já é o nome de exibição, então não
                // duplica informação nenhuma, só a torna endereçável.
                aria-label={nome}
                className="w-full resize-y rounded-sm border border-border bg-paper px-3 py-2 text-ink"
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">
          {noteTypesStatus === "loading" && "Carregando tipos de nota…"}
          {noteTypesStatus === "error" && "Não foi possível carregar os tipos de nota."}
          {noteTypesStatus === "ready" && "Nenhum tipo de nota disponível."}
        </p>
      )}

      <label className="text-sm">
        <span className="mb-1 block text-ink-muted">Etiquetas</span>
        <input
          value={tagsTexto}
          onChange={(event) => setTagsTexto(event.currentTarget.value)}
          placeholder="separadas por vírgula ou espaço"
          className="w-full rounded-sm border border-border bg-paper px-3 py-2 text-ink"
        />
      </label>

      {errorMessage ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {errorMessage}
        </p>
      ) : null}
      {confirmacao ? (
        <p role="status" className="text-sm text-mint-ink">
          {confirmacao}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="submit"
          disabled={status === "salvando" || !deckId || !tipoAtual}
          className="rounded-sm bg-emerald px-4 py-2 text-sm font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
        >
          {status === "salvando" ? "Criando…" : "Criar cartão"}
        </button>
      </div>
    </form>
  );
}
