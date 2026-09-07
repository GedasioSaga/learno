import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AppError, type NoteFieldValues, type NoteRow } from "../../lib/ipc";
import { criarNotaComOrigem } from "./criar-nota-com-origem";
import { lembrarPaginaDoBloco } from "./origem-do-cartao";
import { useCartoesStore } from "./store";
import { flattenAllDecks } from "./tree-utils";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * O que uma origem de cartão sabe sobre si mesma. As três origens do app
 * (ou que vão existir) preenchem isto de formas diferentes:
 *
 * - de uma página de notas: `blocoOrigemId` + `paginaOrigemId`, os dois
 *   preenchidos — ver `src/features/editor/marks/create-card/`;
 * - de um nó de mapa mental: só `trecho` — um nó não é um bloco
 *   (`mindmap_nodes` não referencia `blocks(id)`), então não existe link de
 *   volta possível — ver `src/features/mapa-mental/CartaoNode.tsx`;
 * - de uma anotação de livro (leitor de PDF/EPUB, peça de outro workflow):
 *   também só `trecho`, pelo mesmo motivo — uma página de livro não é um
 *   bloco. Ver o rodapé deste arquivo para como ela deve chamar isto.
 */
export interface OrigemDoCartao {
  /**
   * Vira o TEXTO CONGELADO do cartão (`sourceTextFrozen`) — nunca editado
   * por este formulário, mesmo que o usuário edite o campo da frente depois
   * de pré-preenchido com ele. É a garantia do item 2 do briefing: o texto
   * congelado é sempre o trecho de verdade que originou o cartão.
   */
  trecho: string;
  /**
   * O bloco de onde `trecho` veio (`sourceBlockId`), quando a origem é uma
   * página de notas. `null`/ausente: sem link de volta.
   */
  blocoOrigemId?: string | null;
  /**
   * A página onde `blocoOrigemId` mora agora — só faz sentido junto de
   * `blocoOrigemId`. Usado só para `lembrarPaginaDoBloco` (ver
   * `origem-do-cartao.ts`) depois que o cartão nasce; nunca enviado ao
   * backend.
   */
  paginaOrigemId?: string | null;
}

export interface CriarCartaoDeOrigemProps {
  isOpen: boolean;
  origem: OrigemDoCartao;
  onClose: () => void;
  /** Chamado com a nota recém-criada, antes de `onClose`. */
  onCriado?: (nota: NoteRow) => void;
}

/**
 * O formulário curto de "criar cartão a partir de..." — pensado para ser
 * chamado de qualquer lugar do app que tenha um trecho de texto e,
 * opcionalmente, o bloco de onde ele veio. `<dialog>` nativo, mesmo padrão de
 * `TrashDialog`/`MoveToDialog` (`src/features/pages/`): foco preso e fechar
 * com Escape/clique fora de graça, sem lib extra.
 *
 * Deliberadamente sem seletor de tipo de nota: a promessa do briefing é
 * "o usuário escolhe o baralho e escreve o verso", não escolhe um tipo de
 * nota — usa sempre o primeiro tipo disponível (tipicamente "Básico"), cujo
 * primeiro campo é a frente. Quem precisar de outro tipo de nota continua
 * tendo `CriarCartao.tsx` (a tela cheia, com o seletor).
 */
export function CriarCartaoDeOrigem({ isOpen, origem, onClose, onCriado }: CriarCartaoDeOrigemProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const childrenIndex = useCartoesStore((state) => state.childrenIndex);
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);
  const noteTypes = useCartoesStore((state) => state.noteTypes);
  const noteTypesStatus = useCartoesStore((state) => state.noteTypesStatus);
  const loadNoteTypes = useCartoesStore((state) => state.loadNoteTypes);

  const decksAchatados = useMemo(() => flattenAllDecks(childrenIndex), [childrenIndex]);
  const tipoAtual = noteTypes[0] ?? null;
  const [primeiroCampo, ...camposDoVerso] = tipoAtual?.fields ?? [];

  const [deckId, setDeckId] = useState<string | null>(null);
  const [campos, setCampos] = useState<NoteFieldValues>({});
  const [status, setStatus] = useState<"idle" | "salvando" | "erro">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    void loadNoteTypes();
  }, [loadNoteTypes]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // `typeof` checado, não chamado direto: o jsdom dos testes de componente
    // não implementa `showModal`/`close` — mesma guarda de `TrashDialog`.
    if (isOpen) {
      if (typeof dialog.showModal === "function") dialog.showModal();
    } else if (typeof dialog.close === "function") {
      dialog.close();
    }
  }, [isOpen]);

  // Só a TRANSIÇÃO de fechado para aberto reseta baralho/status — uma
  // mudança de baralho enquanto o usuário já está com o formulário aberto
  // não deveria apagar o que ele escolheu. `deckSelecionadoId`/`decksAchatados`
  // ficam fora da lista de propósito: só o efeito de ABRIR deve lê-los, não
  // toda mudança neles enquanto o formulário já está com o usuário.
  useEffect(() => {
    if (!isOpen) return;
    setDeckId(deckSelecionadoId ?? decksAchatados[0]?.deck.id ?? null);
    setCampos({});
    setStatus("idle");
    setErrorMessage(null);
  }, [isOpen]);

  // O trecho entra na frente assim que o tipo de nota (logo, `primeiroCampo`)
  // é conhecido — a promessa do briefing ("trecho já preenchido na frente").
  // Reage a `origem` para o mesmo diálogo, reaberto com um trecho novo antes
  // de `noteTypes` ter motivo para mudar, ainda pré-preencher corretamente.
  useEffect(() => {
    if (!isOpen || !primeiroCampo) return;
    setCampos((atual) => ({ ...atual, [primeiroCampo]: origem.trecho }));
  }, [isOpen, primeiroCampo, origem]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deckId || !tipoAtual) return;

    const preenchidos: NoteFieldValues = Object.fromEntries(
      tipoAtual.fields.map((nome) => [nome, campos[nome]?.trim() ?? ""]),
    );
    // A frente já vem pré-preenchida com o trecho — checar "algum campo tem
    // conteúdo" (como `CriarCartao.tsx` faz) seria sempre verdadeiro aqui e
    // nunca bloquearia nada. O que precisa de conteúdo de verdade é o VERSO;
    // sem nenhum campo de verso (tipo de nota com um campo só), a frente já
    // preenchida basta.
    const versoPreenchido = camposDoVerso.length === 0 || camposDoVerso.some((nome) => preenchidos[nome] !== "");
    if (!versoPreenchido) {
      setErrorMessage("Escreva ao menos o verso.");
      return;
    }

    setStatus("salvando");
    setErrorMessage(null);
    try {
      const nota = await criarNotaComOrigem(
        deckId,
        tipoAtual.id,
        preenchidos,
        [],
        origem.blocoOrigemId ?? null,
        origem.trecho,
      );
      if (origem.blocoOrigemId && origem.paginaOrigemId) {
        lembrarPaginaDoBloco(origem.blocoOrigemId, origem.paginaOrigemId);
      }
      // Mesmo motivo de `CriarCartao.tsx`: o baralho que acabou de ganhar um
      // cartão tem "novos" desatualizado no painel até este refresh.
      void useCartoesStore.getState().refreshAllCounts();
      setStatus("idle");
      onCriado?.(nota);
      onClose();
    } catch (error) {
      setErrorMessage(messageFor(error, "Não foi possível criar o cartão."));
      setStatus("erro");
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-label="Criar cartão"
      className="w-full max-w-md rounded-md border border-border bg-surface p-0 text-ink shadow-hard backdrop:bg-ink/40"
    >
      {isOpen ? (
        decksAchatados.length === 0 ? (
          <div className="flex flex-col gap-3 p-6">
            <p className="text-sm text-ink-muted">Crie um baralho antes de criar cartões.</p>
            <button
              type="button"
              onClick={onClose}
              className="self-end rounded-sm border border-border bg-surface px-3 py-1.5 text-sm text-ink"
            >
              Fechar
            </button>
          </div>
        ) : (
          <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4 p-6">
            <h2 className="font-display text-lg text-ink">Criar cartão</h2>

            <label className="text-sm">
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

            {tipoAtual && primeiroCampo ? (
              <div className="flex flex-col gap-3">
                <label className="text-sm">
                  <span className="mb-1 block text-ink-muted">{primeiroCampo}</span>
                  <textarea
                    value={campos[primeiroCampo] ?? ""}
                    onChange={(event) => {
                      const valor = event.currentTarget.value;
                      setCampos((atual) => ({ ...atual, [primeiroCampo]: valor }));
                    }}
                    rows={2}
                    aria-label={primeiroCampo}
                    className="w-full resize-y rounded-sm border border-border bg-paper px-3 py-2 text-ink"
                  />
                </label>
                {camposDoVerso.map((nome) => (
                  <label key={nome} className="text-sm">
                    <span className="mb-1 block text-ink-muted">{nome}</span>
                    <textarea
                      value={campos[nome] ?? ""}
                      onChange={(event) => {
                        const valor = event.currentTarget.value;
                        setCampos((atual) => ({ ...atual, [nome]: valor }));
                      }}
                      rows={3}
                      aria-label={nome}
                      autoFocus={nome === camposDoVerso[0]}
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

            {errorMessage ? (
              <p role="alert" className="text-sm text-terracotta-ink">
                {errorMessage}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-sm border border-border bg-surface px-4 py-2 text-sm text-ink transition hover:bg-surface-raised active:scale-97"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={status === "salvando" || !deckId || !tipoAtual}
                className="rounded-sm bg-emerald px-4 py-2 text-sm font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
              >
                {status === "salvando" ? "Criando…" : "Criar cartão"}
              </button>
            </div>
          </form>
        )
      ) : null}
    </dialog>
  );
}
