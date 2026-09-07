import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { AppError, type NoteFieldValues, type NoteRow } from "../../lib/ipc";
import type { OrigemDoCartao } from "./CriarCartaoDeOrigem";
import "./criar-lacuna.css";
import { criarNotaComOrigem } from "./criar-nota-com-origem";
import {
  cartoesDe,
  MENSAGEM_DE_RECUSA,
  mesmaLacuna,
  montarTextoCloze,
  novaLacuna,
  numeroAtual,
  proximoNumero,
  removerLacuna,
  segmentosDoCartao,
  type Intervalo,
  type Lacuna,
  type MotivoDeRecusa,
} from "./lacunas";
import { lembrarPaginaDoBloco } from "./origem-do-cartao";
import { ATRIBUTO_INICIO, intervaloSelecionadoEm } from "./selecao-no-texto";
import { useCartoesStore } from "./store";
import { CLASSE_LACUNA_ESCONDIDA, LACUNA_VAZIA } from "./TextoComLacuna";
import { flattenAllDecks } from "./tree-utils";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * O que uma origem de LACUNA sabe além de `OrigemDoCartao`: o texto inteiro
 * do bloco e onde o trecho está nele. `trecho` continua sendo o texto
 * congelado do cartão (`sourceTextFrozen`), como em qualquer outra origem —
 * só que aqui ele também é a primeira lacuna, já marcada quando o
 * formulário abre.
 */
export interface OrigemDeLacuna extends OrigemDoCartao {
  /** O texto do bloco inteiro — vira o campo `Texto` da nota, com as lacunas embrulhadas. Nunca é gravado de volta na página. */
  textoDoBloco: string;
  /** Onde `trecho` está dentro de `textoDoBloco`. */
  selecao: Intervalo;
}

export interface CriarLacunaDeOrigemProps {
  isOpen: boolean;
  origem: OrigemDeLacuna;
  onClose: () => void;
  onCriado?: (nota: NoteRow) => void;
}

type ModoDeMarcacao = "nova" | "mesma";

/** Um pedaço da prévia: literal ou lacuna. `inicio` é o índice no texto do bloco (ver `selecao-no-texto.ts`). */
interface Pedaco {
  inicio: number;
  texto: string;
  lacuna: Lacuna | null;
}

function pedacosDoTexto(texto: string, lacunas: readonly Lacuna[]): Pedaco[] {
  const pedacos: Pedaco[] = [];
  let cursor = 0;
  for (const lacuna of lacunas) {
    if (lacuna.inicio > cursor) pedacos.push({ inicio: cursor, texto: texto.slice(cursor, lacuna.inicio), lacuna: null });
    pedacos.push({ inicio: lacuna.inicio, texto: texto.slice(lacuna.inicio, lacuna.fim), lacuna });
    cursor = lacuna.fim;
  }
  if (cursor < texto.length) pedacos.push({ inicio: cursor, texto: texto.slice(cursor), lacuna: null });
  return pedacos;
}

/** Mesmo motivo de `CreateCardButton`: sem isto o mousedown colapsa a seleção da prévia antes do clique chegar. */
function preservarSelecao(event: MouseEvent) {
  event.preventDefault();
}

/**
 * Cria uma nota do tipo Cloze a partir de um trecho selecionado numa página.
 *
 * ## A decisão de desenho: as lacunas são marcadas AQUI, numa cópia
 *
 * O usuário seleciona UM trecho na página, mas uma nota cloze útil costuma
 * ter mais de uma lacuna sobre a mesma frase. Havia dois jeitos de permitir
 * isso: acumular seleções NA PÁGINA antes de abrir o formulário, ou marcar
 * DENTRO do formulário, sobre uma cópia do texto do bloco. Este componente
 * faz o segundo, por três razões:
 *
 * 1. **A página não muda.** É um invariante da bar: marcar lacuna cria um
 *    cartão, não edita a nota de origem. Acumular na página exigiria
 *    decorações no editor que PARECEM edição — e é exatamente a surpresa que
 *    se quer evitar. Aqui a cópia está visivelmente dentro de um diálogo
 *    chamado "Criar cartão", e o bloco continua intocado atrás dele.
 * 2. **A prévia de quantos cartões nascem só faz sentido junto do texto.**
 *    A lista de cartões abaixo do texto atualiza a cada marcação; com
 *    seleções acumuladas na página não haveria onde mostrá-la antes de
 *    abrir o formulário.
 * 3. **O gesto é o mesmo do Anki, só que sobre a cópia.** Selecionar +
 *    `Ctrl+Shift+C` (nova pergunta, número incrementa) e selecionar +
 *    `Ctrl+Shift+Alt+C` (mesmo número, um buraco a mais na pergunta atual)
 *    funcionam aqui dentro; e os dois também são botões, cada um mostrando
 *    o número que vai produzir — a escolha aparece sem explicação.
 *
 * O que torna a escolha visível sem texto: cada botão carrega o número
 * (`c2` vs `c1`), e "nova lacuna" faz um cartão A MAIS aparecer na lista de
 * prévias, enquanto "mesma lacuna" só abre um segundo buraco no cartão que
 * já estava lá. O botão de salvar diz "Criar 2 cartões".
 *
 * `<dialog>` nativo, mesmo padrão de `CriarCartaoDeOrigem`/`TrashDialog`.
 * Tipo de nota escolhido por `kind === "cloze"`, nunca por nome — ver
 * `NoteTypeRow.kind` em `src/lib/ipc.ts`.
 */
export function CriarLacunaDeOrigem({ isOpen, origem, onClose, onCriado }: CriarLacunaDeOrigemProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previaRef = useRef<HTMLParagraphElement>(null);
  const childrenIndex = useCartoesStore((state) => state.childrenIndex);
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);
  const noteTypes = useCartoesStore((state) => state.noteTypes);
  const noteTypesStatus = useCartoesStore((state) => state.noteTypesStatus);
  const loadNoteTypes = useCartoesStore((state) => state.loadNoteTypes);

  const decksAchatados = useMemo(() => flattenAllDecks(childrenIndex), [childrenIndex]);
  const tipoCloze = useMemo(() => noteTypes.find((tipo) => tipo.kind === "cloze") ?? null, [noteTypes]);
  const [campoTexto, ...camposExtras] = tipoCloze?.fields ?? [];

  const texto = origem.textoDoBloco;

  const [deckId, setDeckId] = useState<string | null>(null);
  const [lacunas, setLacunas] = useState<Lacuna[]>([]);
  const [selecaoNaPrevia, setSelecaoNaPrevia] = useState<Intervalo | null>(null);
  const [recusa, setRecusa] = useState<MotivoDeRecusa | null>(null);
  // Só o cartão que acabou de NASCER anima, e só quando a ação veio do
  // mouse — ação por teclado não anima (régua de movimento, regra 3).
  const [cartaoRecemNascido, setCartaoRecemNascido] = useState<number | null>(null);
  const [extras, setExtras] = useState<NoteFieldValues>({});
  const [status, setStatus] = useState<"idle" | "salvando" | "erro">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const cartoes = cartoesDe(lacunas);
  const numeroNovo = proximoNumero(lacunas);
  const numeroMesmo = numeroAtual(lacunas);

  useEffect(() => {
    void loadNoteTypes();
  }, [loadNoteTypes]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (typeof dialog.showModal === "function") dialog.showModal();
    } else if (typeof dialog.close === "function") {
      dialog.close();
    }
  }, [isOpen]);

  // Só a transição de fechado para aberto reseta o estado — mesmo motivo de
  // `CriarCartaoDeOrigem`. A primeira lacuna é o trecho que o usuário
  // selecionou na página; se ele não serve (contém `{{`, por exemplo), o
  // formulário abre SEM lacuna e com o motivo à vista, em vez de fingir.
  useEffect(() => {
    if (!isOpen) return;
    setDeckId(deckSelecionadoId ?? decksAchatados[0]?.deck.id ?? null);
    const primeira = novaLacuna(origem.textoDoBloco, [], origem.selecao);
    setLacunas(primeira.ok ? primeira.lacunas : []);
    setRecusa(primeira.ok ? null : primeira.motivo);
    setSelecaoNaPrevia(null);
    setCartaoRecemNascido(null);
    setExtras({});
    setStatus("idle");
    setErrorMessage(null);
  }, [isOpen, origem]);

  // A seleção dentro da prévia é lida no `selectionchange` do documento,
  // que não passa pelo React — `selecao-no-texto.ts` converte em índices.
  useEffect(() => {
    if (!isOpen) return;
    function ler() {
      const previa = previaRef.current;
      setSelecaoNaPrevia(previa ? intervaloSelecionadoEm(previa, document.getSelection()) : null);
    }
    document.addEventListener("selectionchange", ler);
    return () => document.removeEventListener("selectionchange", ler);
  }, [isOpen]);

  function marcar(modo: ModoDeMarcacao, porTeclado: boolean) {
    if (!selecaoNaPrevia) return;
    const resultado =
      modo === "nova" ? novaLacuna(texto, lacunas, selecaoNaPrevia) : mesmaLacuna(texto, lacunas, selecaoNaPrevia);
    if (!resultado.ok) {
      setRecusa(resultado.motivo);
      return;
    }
    const nasceuCartao = modo === "nova" || lacunas.length === 0;
    setCartaoRecemNascido(nasceuCartao && !porTeclado ? numeroNovo : null);
    setLacunas(resultado.lacunas);
    setRecusa(null);
    setSelecaoNaPrevia(null);
    // A prévia re-renderiza com a lacuna nova; a seleção antiga apontaria
    // para nós que não existem mais.
    document.getSelection()?.removeAllRanges();
  }

  function remover(lacuna: Lacuna) {
    setLacunas((atuais) => removerLacuna(atuais, lacuna));
    setCartaoRecemNascido(null);
    setRecusa(null);
  }

  // Os atalhos do Anki, sobre a cópia: `Ctrl+Shift+C` nova pergunta,
  // `Ctrl+Shift+Alt+C` mesmo número. `metaKey` por paridade com macOS.
  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "c") return;
    event.preventDefault();
    marcar(event.altKey ? "mesma" : "nova", true);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deckId || !tipoCloze || !campoTexto) return;
    if (lacunas.length === 0) {
      setErrorMessage("Marque ao menos uma lacuna — sem ela o cartão não tem o que perguntar.");
      return;
    }

    const campos: NoteFieldValues = {
      [campoTexto]: montarTextoCloze(texto, lacunas),
      ...Object.fromEntries(camposExtras.map((nome) => [nome, extras[nome]?.trim() ?? ""])),
    };

    setStatus("salvando");
    setErrorMessage(null);
    try {
      const nota = await criarNotaComOrigem(deckId, tipoCloze.id, campos, [], origem.blocoOrigemId ?? null, origem.trecho);
      if (origem.blocoOrigemId && origem.paginaOrigemId) {
        lembrarPaginaDoBloco(origem.blocoOrigemId, origem.paginaOrigemId);
      }
      void useCartoesStore.getState().refreshAllCounts();
      setStatus("idle");
      onCriado?.(nota);
      onClose();
    } catch (error) {
      setErrorMessage(messageFor(error, "Não foi possível criar o cartão."));
      setStatus("erro");
    }
  }

  const textoVazio = texto.trim() === "";
  const podeMarcar = selecaoNaPrevia !== null;
  const rotuloDeCriar =
    cartoes.length === 0 ? "Criar cartão" : cartoes.length === 1 ? "Criar 1 cartão" : `Criar ${cartoes.length} cartões`;

  function renderAviso(mensagem: string) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <p className="text-sm text-ink-muted">{mensagem}</p>
        <button
          type="button"
          onClick={onClose}
          className="self-end rounded-sm border border-border bg-surface px-3 py-1.5 text-sm text-ink"
        >
          Fechar
        </button>
      </div>
    );
  }

  function renderConteudo() {
    if (decksAchatados.length === 0) return renderAviso("Crie um baralho antes de criar cartões.");
    if (textoVazio) return renderAviso("Este bloco não tem texto para virar lacuna.");
    if (noteTypesStatus === "loading") return renderAviso("Carregando tipos de nota…");
    if (noteTypesStatus === "error") return renderAviso("Não foi possível carregar os tipos de nota.");
    if (!tipoCloze || !campoTexto) return renderAviso("O tipo de nota Cloze não está disponível nesta instalação.");

    return (
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4 p-6">
        <h2 className="font-display text-lg text-ink">Criar cartão de lacuna</h2>

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

        <div className="text-sm">
          <p id="lacuna-instrucao" className="mb-1 text-ink-muted">
            {campoTexto} — selecione outro trecho aqui para marcar mais lacunas
          </p>
          <p
            ref={previaRef}
            aria-describedby="lacuna-instrucao"
            className="max-w-[var(--measure)] select-text whitespace-pre-wrap rounded-sm border border-border bg-paper px-3 py-2 text-base leading-relaxed text-ink"
          >
            {pedacosDoTexto(texto, lacunas).map((pedaco) => {
              const { lacuna } = pedaco;
              if (!lacuna) {
                return (
                  <span key={pedaco.inicio} {...{ [ATRIBUTO_INICIO]: pedaco.inicio }}>
                    {pedaco.texto}
                  </span>
                );
              }
              return (
                <span key={pedaco.inicio} className="rounded-sm border-b-2 border-amber bg-amber/10 px-1 text-amber-ink">
                  <span className="sr-only">lacuna {lacuna.numero}: </span>
                  <span {...{ [ATRIBUTO_INICIO]: pedaco.inicio }}>{pedaco.texto}</span>
                  <sup aria-hidden="true" className="ml-0.5 text-xs font-medium">
                    {lacuna.numero}
                  </sup>
                  <button
                    type="button"
                    aria-label={`Remover lacuna ${lacuna.numero}: ${pedaco.texto}`}
                    onMouseDown={preservarSelecao}
                    onClick={() => remover(lacuna)}
                    className="ml-0.5 inline-flex size-5 items-center justify-center rounded-sm align-middle text-ink-muted transition hover:bg-surface-raised hover:text-ink active:scale-97"
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!podeMarcar}
            onMouseDown={preservarSelecao}
            onClick={() => marcar("nova", false)}
            className="inline-flex items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink shadow-hard-sm transition hover:bg-surface-raised active:scale-97 active:shadow-none disabled:opacity-50 disabled:pointer-events-none"
          >
            Nova lacuna
            <span className={CLASSE_LACUNA_ESCONDIDA} aria-hidden="true">
              {numeroNovo}
            </span>
            <kbd className="text-xs text-ink-muted">Ctrl+Shift+C</kbd>
          </button>
          <button
            type="button"
            disabled={!podeMarcar || numeroMesmo === null}
            onMouseDown={preservarSelecao}
            onClick={() => marcar("mesma", false)}
            className="inline-flex items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink shadow-hard-sm transition hover:bg-surface-raised active:scale-97 active:shadow-none disabled:opacity-50 disabled:pointer-events-none"
          >
            Mesma lacuna
            <span className={CLASSE_LACUNA_ESCONDIDA} aria-hidden="true">
              {numeroMesmo ?? LACUNA_VAZIA}
            </span>
            <kbd className="text-xs text-ink-muted">Ctrl+Shift+Alt+C</kbd>
          </button>
          <span role="status" className="text-xs text-ink-muted">
            {podeMarcar ? "" : "Selecione um trecho no texto para marcar."}
          </span>
        </div>

        {recusa ? (
          <p role="alert" className="text-sm text-terracotta-ink">
            {MENSAGEM_DE_RECUSA[recusa]}
          </p>
        ) : null}

        <div>
          <p className="mb-2 text-sm text-ink-muted" aria-live="polite">
            {cartoes.length === 0
              ? "Nenhum cartão ainda — marque ao menos uma lacuna."
              : cartoes.length === 1
                ? "Vai criar 1 cartão"
                : `Vai criar ${cartoes.length} cartões`}
          </p>
          {cartoes.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label="Cartões que vão nascer">
              {cartoes.map((numero) => (
                <li
                  key={numero}
                  className={`rounded-sm border border-border bg-surface px-3 py-2 shadow-hard-sm ${
                    numero === cartaoRecemNascido ? "lacuna-cartao-entra" : ""
                  }`}
                >
                  <p className="mb-1 text-xs text-ink-muted">Cartão {numero}</p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                    {segmentosDoCartao(texto, lacunas, numero).map((segmento, indice) =>
                      segmento.hidden ? (
                        <span key={indice} className={CLASSE_LACUNA_ESCONDIDA}>
                          <span className="sr-only">lacuna</span>
                          <span aria-hidden="true">{LACUNA_VAZIA}</span>
                        </span>
                      ) : (
                        <span key={indice}>{segmento.text}</span>
                      ),
                    )}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {camposExtras.map((nome) => (
          <label key={nome} className="text-sm">
            <span className="mb-1 block text-ink-muted">{nome}</span>
            <textarea
              value={extras[nome] ?? ""}
              onChange={(event) => {
                const valor = event.currentTarget.value;
                setExtras((atual) => ({ ...atual, [nome]: valor }));
              }}
              rows={2}
              aria-label={nome}
              className="w-full resize-y rounded-sm border border-border bg-paper px-3 py-2 text-ink"
            />
          </label>
        ))}

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
            disabled={status === "salvando" || !deckId || cartoes.length === 0}
            className="rounded-sm bg-emerald px-4 py-2 text-sm font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
          >
            {status === "salvando" ? "Criando…" : rotuloDeCriar}
          </button>
        </div>
      </form>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-label="Criar cartão de lacuna"
      className="w-full max-w-lg rounded-md border border-border bg-surface p-0 text-ink shadow-hard backdrop:bg-ink/40"
    >
      {isOpen ? renderConteudo() : null}
    </dialog>
  );
}
