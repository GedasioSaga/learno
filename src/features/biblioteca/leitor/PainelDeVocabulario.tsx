import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { CriarCartaoDeOrigem, type OrigemDoCartao } from "../../cartoes/CriarCartaoDeOrigem";
import {
  AppError,
  atualizarPalavra,
  coletarPalavra,
  definirMarcacaoDaPalavra,
  removerPalavra,
  type PalavraColetada,
} from "../../../lib/ipc";
import { normalizarParaComparar } from "./marcacao-de-vocabulario";

/**
 * Uma seleção de texto já resolvida para o vocabulário: termo cru (o que o
 * usuário selecionou) e a frase de onde ele veio. Forma própria, mais simples
 * que `SelecaoDeTexto` (`./tipos.ts`) — quem monta isto decide como derivar
 * `texto`/`contexto` a partir da seleção nativa de cada formato; este painel
 * só sabe o que fazer com o resultado.
 */
export interface SelecaoParaColeta {
  texto: string;
  contexto: string;
  locator: string;
}

/** Recebe a lista de agora e devolve a próxima — a mesma forma do `setState` da casca, que é quem guarda a lista. */
export type MudarPalavras = (atualizar: (atuais: PalavraColetada[]) => PalavraColetada[]) => void;

interface PainelDeVocabularioProps {
  livroId: string;
  selecao: SelecaoParaColeta | null;
  /**
   * A lista vem da casca (`LeitorDeLivro`), não deste painel: o leitor de
   * formato precisa dela para sublinhar as palavras no livro, e o sublinhado
   * não pode depender de este painel estar montado.
   */
  palavras: readonly PalavraColetada[];
  carregando: boolean;
  /** Erro ao CARREGAR a lista — substitui a lista. Erro de uma ação (salvar, marcar, remover) é deste painel e aparece por cima dela. */
  erro: string | null;
  onMudarPalavras: MudarPalavras;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * A mesma palavra colhida duas vezes no mesmo livro (ignorando caixa/acento)
 * vira `Error::Database` de um gatilho SQLite — ver o comentário de módulo em
 * `src-tauri/src/db/vocabulario.rs` para o porquê de o backend recusar em vez
 * de fundir. A mensagem crua fala de gatilho e tabela ("library_vocabulary.term
 * duplicado..."); aqui ela vira algo que o usuário lê sem se assustar.
 */
function ehErroDeDuplicata(error: unknown): boolean {
  return error instanceof AppError && error.kind === "database" && error.message.includes("duplicado");
}

/** "ávido, faminto ,, " → ["ávido", "faminto"]. Duplicata ignorando caixa e acento quem tira é o Rust, que é a fonte da verdade da lista. */
function separarPorVirgula(texto: string): string[] {
  return texto
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * Hoje a casca passa o próprio trecho selecionado como contexto (a captura de
 * seleção não extrai a frase em volta), e o card mostrava a palavra duas
 * vezes — `“éban”` embaixo de `éban`. Contexto que só repete a palavra não diz
 * nada e some.
 */
function contextoAcrescenta(termo: string, contexto: string | null): contexto is string {
  if (!contexto || contexto.trim() === "") return false;
  return normalizarParaComparar(contexto) !== normalizarParaComparar(termo);
}

function substituirPalavra(atualizada: PalavraColetada) {
  return (atuais: PalavraColetada[]) => atuais.map((palavra) => (palavra.id === atualizada.id ? atualizada : palavra));
}

const CLASSE_DE_CAMPO = "w-full rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink";
const CLASSE_DE_ROTULO = "text-[11px] text-ink-muted";

/** O sublinhado ondulado do livro, em miniatura — o ícone diz o que o botão liga. */
function IconeDeMarcador() {
  return (
    <svg aria-hidden="true" width="14" height="8" viewBox="0 0 14 8" fill="none">
      <path d="M1 5c1.5-3 3-3 4 0s2.5 3 4 0 2.5-3 4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Etiquetas({ titulo, termo, itens }: { titulo: string; termo: string; itens: readonly string[] }) {
  if (itens.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-medium text-ink-muted">{titulo}</p>
      <ul aria-label={`${titulo} de ${termo}`} className="flex flex-wrap gap-1">
        {itens.map((item) => (
          <li key={item} className="rounded-full border border-hairline bg-surface px-2 py-0.5 text-[11px] text-ink">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Os três campos editáveis de uma palavra, como texto de formulário (listas separadas por vírgula). */
interface RascunhoDePalavra {
  nota: string;
  sinonimos: string;
  antonimos: string;
}

function rascunhoDe(palavra: PalavraColetada): RascunhoDePalavra {
  return { nota: palavra.note ?? "", sinonimos: palavra.synonyms.join(", "), antonimos: palavra.antonyms.join(", ") };
}

interface LinhaDePalavraProps {
  palavra: PalavraColetada;
  editando: boolean;
  rascunho: RascunhoDePalavra;
  salvando: boolean;
  confirmandoRemocao: boolean;
  onIniciarEdicao: () => void;
  onMudarRascunho: (rascunho: RascunhoDePalavra) => void;
  onSalvar: () => void;
  onCancelarEdicao: () => void;
  onAlternarMarcacao: () => void;
  onPedirRemocao: () => void;
  onCancelarRemocao: () => void;
  onConfirmarRemocao: () => void;
  onCriarCartao: () => void;
}

/**
 * Uma palavra na lista. Fechada: termo e o começo do significado. Clicar no
 * card abre ali mesmo o significado inteiro e as etiquetas de Sinônimos e de
 * Antônimos; clicar de novo fecha. À direita, as ações — marcador no livro,
 * cartão, lápis (edita os três campos) e remover. Remover exige confirmação
 * NESTE painel, nunca `window.confirm` (diálogo nativo trava a WebView do
 * Tauri) — mesmo padrão de `LinhaDeMateria` em
 * `features/cronograma/PainelDeMaterias.tsx`.
 */
function LinhaDePalavra({
  palavra,
  editando,
  rascunho,
  salvando,
  confirmandoRemocao,
  onIniciarEdicao,
  onMudarRascunho,
  onSalvar,
  onCancelarEdicao,
  onAlternarMarcacao,
  onPedirRemocao,
  onCancelarRemocao,
  onConfirmarRemocao,
  onCriarCartao,
}: LinhaDePalavraProps) {
  const [aberta, setAberta] = useState(false);
  const idBase = useId();
  const idDetalhes = `${idBase}-detalhes`;
  const semNadaPreenchido = !palavra.note && palavra.synonyms.length === 0 && palavra.antonyms.length === 0;

  // Enter salva e Esc cancela nos campos de uma linha; no textarea do
  // significado, Enter continua sendo quebra de linha.
  function aoTeclarNoCampo(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancelarEdicao();
    } else if (event.key === "Enter" && event.currentTarget instanceof HTMLInputElement) {
      event.preventDefault();
      onSalvar();
    }
  }

  return (
    <li className="rounded-md border border-border bg-surface-raised">
      {/* `relative`: o `after:` do botão de abrir cobre só este bloco — o card
          inteiro vira área de clique sem botão dentro de botão, e o
          formulário de edição e a confirmação, que ficam fora daqui, não são
          cobertos. As ações ficam por cima (`relative z-10`). */}
      <div className="relative flex flex-col gap-1.5 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            aria-expanded={aberta}
            aria-controls={idDetalhes}
            onClick={() => setAberta((atual) => !atual)}
            className="flex min-w-0 flex-1 items-baseline gap-1 text-left text-sm font-medium text-ink after:absolute after:inset-0 after:rounded-md after:content-['']"
          >
            <span
              aria-hidden="true"
              className={`shrink-0 text-xs text-ink-muted transition-transform ease-out motion-reduce:transition-none ${
                aberta ? "rotate-90 duration-200" : "duration-150"
              }`}
            >
              ›
            </span>
            <span className="min-w-0 truncate">{palavra.term}</span>
          </button>
          <div className="relative z-10 flex shrink-0 gap-1">
            <button
              type="button"
              onClick={onAlternarMarcacao}
              aria-pressed={palavra.highlightInBook}
              aria-label={`Marcar ${palavra.term} no livro`}
              title={palavra.highlightInBook ? "Sublinhada no livro — clique para tirar" : "Sublinhar no livro"}
              className={`grid size-6 shrink-0 place-items-center rounded-sm transition-[color,background-color,opacity,transform] duration-150 ease-out motion-reduce:transition-none active:scale-97 ${
                palavra.highlightInBook
                  ? "bg-surface text-amber-ink"
                  : "text-ink-muted opacity-60 hover:bg-surface hover:text-ink hover:opacity-100"
              }`}
            >
              <IconeDeMarcador />
            </button>
            <button
              type="button"
              onClick={onCriarCartao}
              className="rounded-sm px-1.5 py-0.5 text-xs text-ink-muted transition hover:bg-surface hover:text-ink motion-reduce:transition-none active:scale-97"
            >
              Cartão
            </button>
            <button
              type="button"
              onClick={onIniciarEdicao}
              aria-label={`Editar ${palavra.term}`}
              className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted hover:bg-surface hover:text-ink"
            >
              ✎
            </button>
            <button
              type="button"
              onClick={onPedirRemocao}
              aria-label={`Remover ${palavra.term}`}
              className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted hover:bg-surface hover:text-terracotta-ink"
            >
              🗑
            </button>
          </div>
        </div>

        {contextoAcrescenta(palavra.term, palavra.contextSnippet) ? (
          <p className="line-clamp-2 text-xs text-ink-muted">“{palavra.contextSnippet}”</p>
        ) : null}

        {!editando && palavra.note ? (
          <p className={aberta ? "whitespace-pre-line text-xs text-ink" : "line-clamp-2 text-xs text-ink-muted"}>
            {palavra.note}
          </p>
        ) : null}

        {/* Abre com `grid-template-rows` 0fr → 1fr: a altura acompanha o
            conteúdo sem medir nada em JS. Fechada, a região continua no DOM
            para a transição de volta existir — `inert` e `aria-hidden` tiram
            ela do teclado e do leitor de tela enquanto isso. Fecha mais rápido
            do que abre (150 contra 200 ms): fechar é resposta, não leitura.
            Com movimento reduzido, a altura troca de uma vez e só o fade de
            opacidade do conteúdo fica.
            Limitação conhecida: o significado longo perde o `line-clamp` na
            hora, então cresce de uma vez enquanto as etiquetas deslizam. */}
        {!editando ? (
          <div
            id={idDetalhes}
            aria-hidden={aberta ? undefined : true}
            inert={!aberta}
            className={`grid transition-[grid-template-rows] ease-out motion-reduce:transition-none ${
              aberta ? "grid-rows-[1fr] duration-200" : "grid-rows-[0fr] duration-150"
            }`}
          >
            <div
              className={`flex min-h-0 flex-col gap-2 overflow-hidden transition-opacity ease-out ${
                aberta ? "opacity-100 duration-200" : "opacity-0 duration-150"
              }`}
            >
              <Etiquetas titulo="Sinônimos" termo={palavra.term} itens={palavra.synonyms} />
              <Etiquetas titulo="Antônimos" termo={palavra.term} itens={palavra.antonyms} />
              {semNadaPreenchido ? (
                <p className="text-xs text-ink-muted">Use o lápis para adicionar significado, sinônimos e antônimos.</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {editando ? (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
          <label htmlFor={`${idBase}-significado`} className={CLASSE_DE_ROTULO}>
            Significado
          </label>
          <textarea
            id={`${idBase}-significado`}
            value={rascunho.nota}
            onChange={(event) => onMudarRascunho({ ...rascunho, nota: event.currentTarget.value })}
            onKeyDown={aoTeclarNoCampo}
            rows={3}
            className={CLASSE_DE_CAMPO}
          />
          <label htmlFor={`${idBase}-sinonimos`} className={CLASSE_DE_ROTULO}>
            Sinônimos
          </label>
          <input
            id={`${idBase}-sinonimos`}
            type="text"
            value={rascunho.sinonimos}
            onChange={(event) => onMudarRascunho({ ...rascunho, sinonimos: event.currentTarget.value })}
            onKeyDown={aoTeclarNoCampo}
            placeholder="separe por vírgula"
            className={CLASSE_DE_CAMPO}
          />
          <label htmlFor={`${idBase}-antonimos`} className={CLASSE_DE_ROTULO}>
            Antônimos
          </label>
          <input
            id={`${idBase}-antonimos`}
            type="text"
            value={rascunho.antonimos}
            onChange={(event) => onMudarRascunho({ ...rascunho, antonimos: event.currentTarget.value })}
            onKeyDown={aoTeclarNoCampo}
            placeholder="separe por vírgula"
            className={CLASSE_DE_CAMPO}
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancelarEdicao} className="text-xs text-ink-muted hover:text-ink">
              Cancelar
            </button>
            <button
              type="button"
              disabled={salvando}
              onClick={onSalvar}
              className="text-xs font-medium text-ink-muted hover:text-ink disabled:opacity-50 disabled:pointer-events-none"
            >
              {salvando ? "Salvando…" : "Salvar"}
            </button>
          </div>
        </div>
      ) : null}

      {confirmandoRemocao ? (
        <div
          role="alertdialog"
          aria-label={`Remover ${palavra.term}?`}
          className="mx-2.5 mb-2.5 flex flex-col gap-2 rounded-sm border border-hairline bg-surface p-2"
        >
          <p className="text-xs text-ink-muted">Remover "{palavra.term}"? Esta ação não pode ser desfeita.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancelarRemocao} className="text-xs text-ink-muted hover:text-ink">
              Cancelar
            </button>
            <button
              type="button"
              onClick={onConfirmarRemocao}
              className="rounded-sm border border-terracotta-ink px-2 py-1 text-xs font-medium text-terracotta-ink hover:bg-surface-raised"
            >
              Remover mesmo assim
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

const RASCUNHO_VAZIO: RascunhoDePalavra = { nota: "", sinonimos: "", antonimos: "" };

/**
 * O painel de vocabulário do leitor: com uma seleção ativa, colhe a palavra
 * (termo da seleção, contexto da frase, significado, sinônimos e antônimos
 * opcionais); sem seleção, lista o que já foi colhido no livro, com busca,
 * edição, marcador no livro e remoção.
 *
 * Dirigido por props — não sabe nada sobre COMO a casca do leitor resolve uma
 * seleção nativa em `SelecaoParaColeta`, só o que fazer com o resultado. A
 * lista mora na casca; este painel faz as chamadas de IPC e devolve a lista
 * nova por `onMudarPalavras`. Igual à ponte de `LeitorDeLivro` com
 * `CriarCartaoDeOrigem`: aqui de novo `trecho` é o único campo que uma origem
 * de vocabulário preenche (`contextSnippet ?? term`) — uma palavra colhida
 * não é um bloco, não existe link de volta.
 */
export function PainelDeVocabulario({ livroId, selecao, palavras, carregando, erro, onMudarPalavras }: PainelDeVocabularioProps) {
  const [busca, setBusca] = useState("");
  const [erroDeAcao, setErroDeAcao] = useState<string | null>(null);

  const [coleta, setColeta] = useState<RascunhoDePalavra>(RASCUNHO_VAZIO);
  const [colhendo, setColhendo] = useState(false);
  const [erroColeta, setErroColeta] = useState<string | null>(null);
  const [colhidaAgora, setColhidaAgora] = useState<PalavraColetada | null>(null);

  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState<RascunhoDePalavra>(RASCUNHO_VAZIO);
  const [salvando, setSalvando] = useState(false);

  const [confirmandoRemocaoId, setConfirmandoRemocaoId] = useState<string | null>(null);

  const [origemCartao, setOrigemCartao] = useState<OrigemDoCartao | null>(null);
  const [cartaoAberto, setCartaoAberto] = useState(false);

  // Comparado por CONTEÚDO (texto/contexto/locator), não pela referência do
  // objeto `selecao`: a casca pode recriar esse objeto a cada render sem o
  // usuário ter selecionado nada novo, e resetar a cada um desses re-renders
  // apagaria o que o usuário está digitando.
  useEffect(() => {
    setColeta(RASCUNHO_VAZIO);
    setErroColeta(null);
    setColhidaAgora(null);
  }, [selecao?.texto, selecao?.contexto, selecao?.locator]);

  const termoDaSelecao = selecao?.texto.trim() ?? "";

  async function colher() {
    if (!selecao || termoDaSelecao === "" || colhendo) return;
    setColhendo(true);
    setErroColeta(null);
    try {
      const contexto = selecao.contexto.trim();
      const locator = selecao.locator.trim();
      const nova = await coletarPalavra(
        livroId,
        termoDaSelecao,
        contexto || null,
        coleta.nota.trim() || null,
        separarPorVirgula(coleta.sinonimos),
        separarPorVirgula(coleta.antonimos),
        locator || null,
      );
      onMudarPalavras((atuais) => [nova, ...atuais]);
      setColhidaAgora(nova);
    } catch (error) {
      setErroColeta(
        ehErroDeDuplicata(error) ? "Essa palavra já foi colhida neste livro." : messageFor(error, "Não foi possível colher esta palavra."),
      );
    } finally {
      setColhendo(false);
    }
  }

  function abrirCriarCartao(palavra: PalavraColetada) {
    setOrigemCartao({ trecho: palavra.contextSnippet ?? palavra.term });
    setCartaoAberto(true);
  }

  function fecharCriarCartao() {
    setCartaoAberto(false);
    setOrigemCartao(null);
  }

  function iniciarEdicao(palavra: PalavraColetada) {
    setEditandoId(palavra.id);
    setRascunho(rascunhoDe(palavra));
  }

  async function salvar(id: string) {
    if (salvando) return;
    setSalvando(true);
    try {
      const atualizada = await atualizarPalavra(
        id,
        rascunho.nota.trim() || null,
        separarPorVirgula(rascunho.sinonimos),
        separarPorVirgula(rascunho.antonimos),
      );
      onMudarPalavras(substituirPalavra(atualizada));
      setEditandoId(null);
      setErroDeAcao(null);
    } catch (error) {
      setErroDeAcao(messageFor(error, "Não foi possível salvar a palavra."));
    } finally {
      setSalvando(false);
    }
  }

  /**
   * Otimista: o botão (e o sublinhado no livro) mudam no clique, sem esperar o
   * IPC. Se o IPC falhar, volta SÓ o marcador — não a palavra inteira de antes
   * do clique, que apagaria uma edição salva no meio do caminho.
   */
  async function alternarMarcacao(palavra: PalavraColetada) {
    const ativa = !palavra.highlightInBook;
    const comMarcador = (valor: boolean) => (atuais: PalavraColetada[]) =>
      atuais.map((atual) => (atual.id === palavra.id ? { ...atual, highlightInBook: valor } : atual));

    onMudarPalavras(comMarcador(ativa));
    setErroDeAcao(null);
    try {
      const atualizada = await definirMarcacaoDaPalavra(palavra.id, ativa);
      onMudarPalavras(substituirPalavra(atualizada));
    } catch (error) {
      onMudarPalavras(comMarcador(!ativa));
      setErroDeAcao(
        messageFor(error, `Não foi possível ${ativa ? "ligar" : "desligar"} o marcador de “${palavra.term}”.`),
      );
    }
  }

  async function remover(id: string) {
    try {
      await removerPalavra(id);
      onMudarPalavras((atuais) => atuais.filter((palavra) => palavra.id !== id));
      setErroDeAcao(null);
    } catch (error) {
      setErroDeAcao(messageFor(error, "Não foi possível remover a palavra."));
    }
  }

  const termoBuscado = busca.trim().toLowerCase();
  // Filtro local, não uma nova chamada a `listarPalavras` (a busca geral, de
  // todos os livros): a lista do livro já está em memória, e filtrar ali
  // mesmo é instantâneo — sem round-trip de IPC a cada tecla.
  const palavrasFiltradas = useMemo(() => {
    if (termoBuscado === "") return palavras;
    const contem = (texto: string | null) => texto?.toLowerCase().includes(termoBuscado) ?? false;
    return palavras.filter(
      (palavra) =>
        contem(palavra.term) ||
        contem(palavra.contextSnippet) ||
        contem(palavra.note) ||
        palavra.synonyms.some(contem) ||
        palavra.antonyms.some(contem),
    );
  }, [palavras, termoBuscado]);

  return (
    <div className="flex flex-col">
      {selecao ? (
        <div className="border-b border-hairline p-3">
          <p className="text-xs font-medium text-ink">Colher palavra</p>
          <p className="mt-1.5 rounded-sm bg-surface-sunken px-2 py-1.5 text-sm text-ink">
            {termoDaSelecao === "" ? "(seleção vazia)" : termoDaSelecao}
          </p>
          {contextoAcrescenta(termoDaSelecao, selecao.contexto) ? (
            <p className="mt-1 line-clamp-3 text-xs text-ink-muted">“{selecao.contexto}”</p>
          ) : null}

          {termoDaSelecao === "" ? (
            <p role="alert" className="mt-2 text-xs text-terracotta-ink">
              Selecione uma palavra para colher.
            </p>
          ) : colhidaAgora ? (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs text-ink-muted">Palavra colhida.</p>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => abrirCriarCartao(colhidaAgora)}
                  className="rounded-sm border border-border bg-surface px-2.5 py-1 text-xs text-ink transition hover:bg-surface-raised motion-reduce:transition-none active:scale-97"
                >
                  Criar cartão
                </button>
              </div>
            </div>
          ) : (
            <>
              <label htmlFor="vocabulario-significado-coleta" className="mt-2 block text-xs text-ink-muted">
                Significado (opcional)
              </label>
              <textarea
                id="vocabulario-significado-coleta"
                value={coleta.nota}
                onChange={(event) => setColeta({ ...coleta, nota: event.currentTarget.value })}
                rows={2}
                className={`mt-1 ${CLASSE_DE_CAMPO}`}
              />
              <label htmlFor="vocabulario-sinonimos-coleta" className="mt-2 block text-xs text-ink-muted">
                Sinônimos (opcional)
              </label>
              <input
                id="vocabulario-sinonimos-coleta"
                type="text"
                value={coleta.sinonimos}
                onChange={(event) => setColeta({ ...coleta, sinonimos: event.currentTarget.value })}
                placeholder="separe por vírgula"
                className={`mt-1 ${CLASSE_DE_CAMPO}`}
              />
              <label htmlFor="vocabulario-antonimos-coleta" className="mt-2 block text-xs text-ink-muted">
                Antônimos (opcional)
              </label>
              <input
                id="vocabulario-antonimos-coleta"
                type="text"
                value={coleta.antonimos}
                onChange={(event) => setColeta({ ...coleta, antonimos: event.currentTarget.value })}
                placeholder="separe por vírgula"
                className={`mt-1 ${CLASSE_DE_CAMPO}`}
              />
              {erroColeta ? (
                <p role="alert" className="mt-2 text-xs text-terracotta-ink">
                  {erroColeta}
                </p>
              ) : null}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={colhendo}
                  onClick={() => void colher()}
                  className="rounded-sm bg-emerald px-2.5 py-1 text-xs font-medium text-on-emerald transition hover:brightness-110 motion-reduce:transition-none disabled:opacity-50 disabled:pointer-events-none"
                >
                  {colhendo ? "Colhendo…" : "Colher palavra"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="border-b border-hairline p-2">
            <input
              type="text"
              value={busca}
              onChange={(event) => setBusca(event.currentTarget.value)}
              placeholder="Buscar palavra…"
              aria-label="Buscar palavra colhida"
              className={CLASSE_DE_CAMPO}
            />
          </div>

          {erroDeAcao && !erro ? (
            <p role="alert" className="px-3 pt-2 text-xs text-terracotta-ink">
              {erroDeAcao}
            </p>
          ) : null}

          {carregando ? (
            <p className="px-3 py-3 text-xs text-ink-muted">Carregando palavras…</p>
          ) : erro ? (
            <p role="alert" className="px-3 py-3 text-xs text-terracotta-ink">
              {erro}
            </p>
          ) : palavras.length === 0 ? (
            <p className="px-3 py-3 text-xs text-ink-muted">
              Nenhuma palavra colhida ainda. Selecione uma palavra durante a leitura para colhê-la aqui.
            </p>
          ) : palavrasFiltradas.length === 0 ? (
            <p className="px-3 py-3 text-xs text-ink-muted">Nenhuma palavra encontrada para “{busca.trim()}”.</p>
          ) : (
            <ul aria-label="Palavras colhidas" className="flex flex-col gap-1.5 overflow-y-auto px-2 py-2">
              {palavrasFiltradas.map((palavra) => (
                <LinhaDePalavra
                  key={palavra.id}
                  palavra={palavra}
                  editando={editandoId === palavra.id}
                  rascunho={rascunho}
                  salvando={salvando}
                  confirmandoRemocao={confirmandoRemocaoId === palavra.id}
                  onIniciarEdicao={() => iniciarEdicao(palavra)}
                  onMudarRascunho={setRascunho}
                  onSalvar={() => void salvar(palavra.id)}
                  onCancelarEdicao={() => setEditandoId(null)}
                  onAlternarMarcacao={() => void alternarMarcacao(palavra)}
                  onPedirRemocao={() => setConfirmandoRemocaoId(palavra.id)}
                  onCancelarRemocao={() => setConfirmandoRemocaoId(null)}
                  onConfirmarRemocao={() => {
                    setConfirmandoRemocaoId(null);
                    void remover(palavra.id);
                  }}
                  onCriarCartao={() => abrirCriarCartao(palavra)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {origemCartao ? <CriarCartaoDeOrigem isOpen={cartaoAberto} origem={origemCartao} onClose={fecharCriarCartao} /> : null}
    </div>
  );
}
