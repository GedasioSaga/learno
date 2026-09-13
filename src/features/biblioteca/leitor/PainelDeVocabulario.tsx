import { useEffect, useMemo, useState } from "react";
import { CriarCartaoDeOrigem, type OrigemDoCartao } from "../../cartoes/CriarCartaoDeOrigem";
import {
  AppError,
  atualizarNotaDaPalavra,
  coletarPalavra,
  listarPalavrasDoLivro,
  removerPalavra,
  type PalavraColetada,
} from "../../../lib/ipc";

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

interface PainelDeVocabularioProps {
  livroId: string;
  selecao: SelecaoParaColeta | null;
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

interface LinhaDePalavraProps {
  palavra: PalavraColetada;
  editando: boolean;
  rascunhoNota: string;
  salvandoNota: boolean;
  confirmandoRemocao: boolean;
  onIniciarEdicao: () => void;
  onMudarRascunho: (valor: string) => void;
  onSalvarNota: () => void;
  onCancelarEdicao: () => void;
  onPedirRemocao: () => void;
  onCancelarRemocao: () => void;
  onConfirmarRemocao: () => void;
  onCriarCartao: () => void;
}

/**
 * Uma palavra na lista: termo, a frase de origem, nota (editável inline) e
 * duas ações — criar cartão e remover. Remover exige confirmação NESTE
 * painel, nunca `window.confirm` (diálogo nativo trava a WebView do Tauri) —
 * mesmo padrão de `LinhaDeMateria` em `features/cronograma/PainelDeMaterias.tsx`.
 */
function LinhaDePalavra({
  palavra,
  editando,
  rascunhoNota,
  salvandoNota,
  confirmandoRemocao,
  onIniciarEdicao,
  onMudarRascunho,
  onSalvarNota,
  onCancelarEdicao,
  onPedirRemocao,
  onCancelarRemocao,
  onConfirmarRemocao,
  onCriarCartao,
}: LinhaDePalavraProps) {
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-raised p-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{palavra.term}</span>
        <div className="flex shrink-0 gap-1">
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
            aria-label={`Editar nota de ${palavra.term}`}
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

      {palavra.contextSnippet ? <p className="line-clamp-2 text-xs text-ink-muted">“{palavra.contextSnippet}”</p> : null}

      {editando ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={rascunhoNota}
            onChange={(event) => onMudarRascunho(event.currentTarget.value)}
            rows={2}
            aria-label={`Nota de ${palavra.term}`}
            className="w-full rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancelarEdicao} className="text-xs text-ink-muted hover:text-ink">
              Cancelar
            </button>
            <button
              type="button"
              disabled={salvandoNota}
              onClick={onSalvarNota}
              className="text-xs font-medium text-ink-muted hover:text-ink disabled:opacity-50 disabled:pointer-events-none"
            >
              {salvandoNota ? "Salvando…" : "Salvar"}
            </button>
          </div>
        </div>
      ) : palavra.note ? (
        <p className="line-clamp-2 text-xs text-ink-muted">{palavra.note}</p>
      ) : null}

      {confirmandoRemocao ? (
        <div
          role="alertdialog"
          aria-label={`Remover ${palavra.term}?`}
          className="flex flex-col gap-2 rounded-sm border border-hairline bg-surface p-2"
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

/**
 * O painel de vocabulário do leitor: com uma seleção ativa, colhe a palavra
 * (termo da seleção, contexto da frase, nota opcional); sem seleção, lista o
 * que já foi colhido no livro, com busca, edição de nota e remoção.
 *
 * Autocontido e dirigido por props (`livroId`/`selecao`) — não sabe nada
 * sobre COMO a casca do leitor resolve uma seleção nativa em
 * `SelecaoParaColeta`, só o que fazer com o resultado. Igual à ponte de
 * `LeitorDeLivro` com `CriarCartaoDeOrigem`: aqui de novo `trecho` é o único
 * campo que uma origem de vocabulário preenche (`contextSnippet ?? term`) —
 * uma palavra colhida não é um bloco, não existe link de volta.
 */
export function PainelDeVocabulario({ livroId, selecao }: PainelDeVocabularioProps) {
  const [palavras, setPalavras] = useState<PalavraColetada[]>([]);
  const [carregandoLista, setCarregandoLista] = useState(true);
  const [erroLista, setErroLista] = useState<string | null>(null);
  const [busca, setBusca] = useState("");

  const [notaColeta, setNotaColeta] = useState("");
  const [colhendo, setColhendo] = useState(false);
  const [erroColeta, setErroColeta] = useState<string | null>(null);
  const [colhidaAgora, setColhidaAgora] = useState<PalavraColetada | null>(null);

  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [rascunhoNota, setRascunhoNota] = useState("");
  const [salvandoNota, setSalvandoNota] = useState(false);

  const [confirmandoRemocaoId, setConfirmandoRemocaoId] = useState<string | null>(null);

  const [origemCartao, setOrigemCartao] = useState<OrigemDoCartao | null>(null);
  const [cartaoAberto, setCartaoAberto] = useState(false);

  useEffect(() => {
    let cancelado = false;
    setCarregandoLista(true);
    setErroLista(null);

    listarPalavrasDoLivro(livroId)
      .then((lista) => {
        if (!cancelado) setPalavras(lista);
      })
      .catch((error: unknown) => {
        if (!cancelado) setErroLista(messageFor(error, "Não foi possível carregar as palavras colhidas."));
      })
      .finally(() => {
        if (!cancelado) setCarregandoLista(false);
      });

    return () => {
      cancelado = true;
    };
  }, [livroId]);

  // Comparado por CONTEÚDO (texto/contexto/locator), não pela referência do
  // objeto `selecao`: a casca pode recriar esse objeto a cada render sem o
  // usuário ter selecionado nada novo, e resetar a cada um desses re-renders
  // apagaria a nota que o usuário está digitando.
  useEffect(() => {
    setNotaColeta("");
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
      const nova = await coletarPalavra(livroId, termoDaSelecao, contexto || null, notaColeta.trim() || null, locator || null);
      setPalavras((atuais) => [nova, ...atuais]);
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

  function iniciarEdicaoDeNota(palavra: PalavraColetada) {
    setEditandoId(palavra.id);
    setRascunhoNota(palavra.note ?? "");
  }

  async function salvarNota(id: string) {
    setSalvandoNota(true);
    try {
      const atualizada = await atualizarNotaDaPalavra(id, rascunhoNota.trim() || null);
      setPalavras((atuais) => atuais.map((palavra) => (palavra.id === id ? atualizada : palavra)));
      setEditandoId(null);
      setErroLista(null);
    } catch (error) {
      setErroLista(messageFor(error, "Não foi possível salvar a nota."));
    } finally {
      setSalvandoNota(false);
    }
  }

  async function remover(id: string) {
    try {
      await removerPalavra(id);
      setPalavras((atuais) => atuais.filter((palavra) => palavra.id !== id));
      setErroLista(null);
    } catch (error) {
      setErroLista(messageFor(error, "Não foi possível remover a palavra."));
    }
  }

  const termoBuscado = busca.trim().toLowerCase();
  // Filtro local, não uma nova chamada a `listarPalavras` (a busca geral, de
  // todos os livros): este painel já tem a lista do livro em memória, e
  // filtrar ali mesmo é instantâneo — sem round-trip de IPC a cada tecla.
  const palavrasFiltradas = useMemo(() => {
    if (termoBuscado === "") return palavras;
    return palavras.filter(
      (palavra) =>
        palavra.term.toLowerCase().includes(termoBuscado) ||
        (palavra.contextSnippet?.toLowerCase().includes(termoBuscado) ?? false) ||
        (palavra.note?.toLowerCase().includes(termoBuscado) ?? false),
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
          {selecao.contexto.trim() !== "" ? <p className="mt-1 line-clamp-3 text-xs text-ink-muted">“{selecao.contexto}”</p> : null}

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
              <label htmlFor="vocabulario-nota-coleta" className="mt-2 block text-xs text-ink-muted">
                Nota (opcional)
              </label>
              <textarea
                id="vocabulario-nota-coleta"
                value={notaColeta}
                onChange={(event) => setNotaColeta(event.currentTarget.value)}
                rows={2}
                className="mt-1 w-full rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink"
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
              className="w-full rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink"
            />
          </div>

          {carregandoLista ? (
            <p className="px-3 py-3 text-xs text-ink-muted">Carregando palavras…</p>
          ) : erroLista ? (
            <p role="alert" className="px-3 py-3 text-xs text-terracotta-ink">
              {erroLista}
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
                  rascunhoNota={rascunhoNota}
                  salvandoNota={salvandoNota}
                  confirmandoRemocao={confirmandoRemocaoId === palavra.id}
                  onIniciarEdicao={() => iniciarEdicaoDeNota(palavra)}
                  onMudarRascunho={setRascunhoNota}
                  onSalvarNota={() => void salvarNota(palavra.id)}
                  onCancelarEdicao={() => setEditandoId(null)}
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
