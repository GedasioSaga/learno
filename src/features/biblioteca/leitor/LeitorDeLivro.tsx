import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { CriarCartaoDeOrigem, type OrigemDoCartao } from "../../cartoes/CriarCartaoDeOrigem";
import {
  AppError,
  abrirLivro,
  criarAnotacao,
  listarAnotacoes,
  registrarProgresso,
  type Anotacao,
  type LivroAberto,
} from "../../../lib/ipc";
import { useBibliotecaStore } from "../store";
import { LeitorEpub } from "./epub/LeitorEpub";
import { PainelDeAnotacoes, ROTULO_DO_LOCATOR } from "./PainelDeAnotacoes";
import { PainelDePaginas } from "./PainelDePaginas";
import { PainelDeVocabulario, type SelecaoParaColeta } from "./PainelDeVocabulario";
import { LeitorPdf } from "./pdf/LeitorPdf";
import type { NavegacaoDoLeitor, PosicaoDeLeitura, SelecaoDeTexto } from "./tipos";

interface LeitorDeLivroProps {
  livroId: string;
  onVoltar: () => void;
}

const CORES_DE_DESTAQUE = ["amber", "mint", "terracotta"] as const;
type CorDeDestaque = (typeof CORES_DE_DESTAQUE)[number];

const CLASSE_DA_COR: Record<CorDeDestaque, string> = {
  amber: "bg-amber",
  mint: "bg-mint",
  terracotta: "bg-terracotta",
};

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/** `true` quando o alvo do evento já é um campo de texto — teclado de navegação não deve roubar a digitação de um número de página ou de uma nota. */
function alvoEhCampoDeTexto(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
}

/**
 * A casca do leitor (ponto 1 do contrato): cabeçalho, barra de progresso,
 * navegação por teclado e o painel de anotações — tudo que os DOIS formatos
 * compartilham. O que é do formato (renderizar, paginar, resolver locator)
 * fica atrás de `PropsDoLeitorDeFormato`/`NavegacaoDoLeitor` (`./tipos.ts`);
 * hoje só `LeitorPdf` existe, e é o único lugar aqui que sabe que PDF existe.
 * Um `LeitorEpub` futuro entra no `switch` de `renderizarCorpo` sem esta
 * casca mudar de forma.
 */
export function LeitorDeLivro({ livroId, onVoltar }: LeitorDeLivroProps) {
  const [carregando, setCarregando] = useState(true);
  const [erroAbertura, setErroAbertura] = useState<string | null>(null);
  const [livroAberto, setLivroAberto] = useState<LivroAberto | null>(null);
  // Erro do FORMATO (ex.: `getDocument` falhou) — bloqueante, substitui a
  // área de leitura, porque não há página nenhuma para mostrar por baixo.
  const [erroFormato, setErroFormato] = useState<string | null>(null);
  // Erro ao GRAVAR progresso — não bloqueante: o usuário está no meio da
  // leitura, e uma falha transitória ao salvar não pode arrancar a página
  // que ele está lendo. Aparece como um aviso por cima, a leitura continua.
  const [erroProgresso, setErroProgresso] = useState<string | null>(null);
  const [posicao, setPosicao] = useState<PosicaoDeLeitura | null>(null);

  const [anotacoes, setAnotacoes] = useState<Anotacao[]>([]);
  const [anotacoesCarregando, setAnotacoesCarregando] = useState(true);
  const [anotacoesErro, setAnotacoesErro] = useState<string | null>(null);

  const [selecaoPendente, setSelecaoPendente] = useState<SelecaoDeTexto | null>(null);
  const [notaRascunho, setNotaRascunho] = useState("");
  const [corRascunho, setCorRascunho] = useState<CorDeDestaque>("amber");
  const [salvandoAnotacao, setSalvandoAnotacao] = useState(false);

  // A terceira origem de cartão do app (as outras duas: um bloco de página,
  // `src/features/editor/marks/create-card/`; um nó de mapa mental,
  // `src/features/mapa-mental/criar-cartao-de-no-store.ts`). Local ao
  // componente, não uma store à parte como as outras duas usam: aqui o
  // gatilho ("Criar cartão" na barra lateral) e o formulário nascem na MESMA
  // árvore React — as outras origens precisavam de uma ponte porque o
  // gatilho vive fora do React (editor) ou num nó isolado do canvas
  // (mapa mental); aqui não há essa distância a atravessar.
  const [origemCartao, setOrigemCartao] = useState<OrigemDoCartao | null>(null);
  const [cartaoAberto, setCartaoAberto] = useState(false);

  const navegacaoRef = useRef<NavegacaoDoLeitor>(null);

  useEffect(() => {
    let cancelado = false;
    setCarregando(true);
    setErroAbertura(null);

    abrirLivro(livroId)
      .then((aberto) => {
        if (cancelado) return;
        setLivroAberto(aberto);
        setPosicao({ locator: aberto.progresso.currentLocator ?? "", fraction: aberto.progresso.currentFraction });
      })
      .catch((error: unknown) => {
        if (cancelado) return;
        setErroAbertura(messageFor(error, "Não foi possível abrir este livro."));
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });

    return () => {
      cancelado = true;
    };
  }, [livroId]);

  useEffect(() => {
    let cancelado = false;
    setAnotacoesCarregando(true);
    setAnotacoesErro(null);

    listarAnotacoes(livroId)
      .then((lista) => {
        if (!cancelado) setAnotacoes(lista);
      })
      .catch((error: unknown) => {
        if (!cancelado) setAnotacoesErro(messageFor(error, "Não foi possível carregar as anotações."));
      })
      .finally(() => {
        if (!cancelado) setAnotacoesCarregando(false);
      });

    return () => {
      cancelado = true;
    };
  }, [livroId]);

  // Setas e PageUp/PageDown viram página — sempre que o leitor está aberto e
  // o foco não está num campo de texto (o número de página, a nota da
  // anotação). Um listener em `window`, não no leitor: o usuário pode ter
  // clicado em qualquer lugar da tela, e a tecla ainda deve funcionar.
  useEffect(() => {
    function aoTeclar(event: KeyboardEvent) {
      if (alvoEhCampoDeTexto(event.target)) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        navegacaoRef.current?.proximo();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        navegacaoRef.current?.anterior();
      }
    }

    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, []);

  async function aoVirarPagina(novaPosicao: PosicaoDeLeitura) {
    setPosicao(novaPosicao);
    setErroProgresso(null);
    try {
      const atualizado = await registrarProgresso(livroId, novaPosicao.locator, novaPosicao.fraction);
      // A estante lê `progresso.furthestFraction` direto da lista que já tem
      // em memória (`ConteudoDeBiblioteca`/`LivroCard`) — sem isto, a barra
      // do card continuaria mostrando o valor de quando o livro foi aberto
      // até o usuário sair da leitura e a lista recarregar.
      useBibliotecaStore.getState().atualizarProgressoNaEstante(livroId, atualizado);
    } catch (error) {
      setErroProgresso(messageFor(error, "Não foi possível salvar seu progresso agora."));
    }
  }

  function aoSelecionarTexto(selecao: SelecaoDeTexto | null) {
    setSelecaoPendente(selecao);
    if (!selecao) setNotaRascunho("");
  }

  // Compartilhada por três lugares (cancelar o destaque, destaque salvo com
  // sucesso, cartão criado com sucesso) — o mínimo de usos reais para
  // justificar extrair (regra 10). `NavegacaoDoLeitor.limparSelecao`, nunca
  // `window.getSelection()` direto: a seleção de um EPUB vive no `window` do
  // iframe de conteúdo do epub.js, não no `window` desta página — só o
  // leitor do formato ativo sabe qual documento limpar.
  function limparSelecaoPendente() {
    setSelecaoPendente(null);
    setNotaRascunho("");
    navegacaoRef.current?.limparSelecao();
  }

  function cancelarDestaque() {
    limparSelecaoPendente();
  }

  async function confirmarDestaque() {
    if (!selecaoPendente || salvandoAnotacao) return;
    setSalvandoAnotacao(true);
    try {
      const nova = await criarAnotacao({
        livroId,
        kind: "highlight",
        locatorStart: selecaoPendente.locatorStart,
        locatorEnd: selecaoPendente.locatorEnd,
        fraction: selecaoPendente.fraction,
        excerpt: selecaoPendente.excerpt,
        note: notaRascunho.trim() || null,
        color: corRascunho,
      });
      setAnotacoes((atuais) => [nova, ...atuais]);
      limparSelecaoPendente();
    } catch (error) {
      setAnotacoesErro(messageFor(error, "Não foi possível salvar a anotação."));
    } finally {
      setSalvandoAnotacao(false);
    }
  }

  function aoIrParaAnotacao(anotacao: Anotacao) {
    navegacaoRef.current?.irParaLocator(anotacao.locatorStart);
  }

  /**
   * Abre o formulário compartilhado (`CriarCartaoDeOrigem`) com o trecho
   * selecionado. Só `trecho` viaja — sem `blocoOrigemId`: um trecho de livro
   * não é um bloco (`notes.source_block_id` referencia `blocks(id)`, e uma
   * página de livro nunca tem um), então este cartão nasce, como o de um nó
   * de mapa mental, sem link clicável de volta. Abrir/fechar NÃO mexe na
   * posição de leitura (nenhuma chamada a `navegacaoRef` além de
   * `limparSelecao`, que só limpa a seleção nativa, nunca vira página) — o
   * usuário continua exatamente onde estava depois de criar o cartão.
   */
  function abrirCriarCartao() {
    if (!selecaoPendente) return;
    setOrigemCartao({ trecho: selecaoPendente.excerpt });
    setCartaoAberto(true);
  }

  function fecharCriarCartao() {
    setCartaoAberto(false);
    setOrigemCartao(null);
  }

  function aoCriarCartaoConcluido() {
    limparSelecaoPendente();
  }

  const titulo = livroAberto
    ? (livroAberto.livro.metadataTitle ?? livroAberto.livro.originalFileName)
    : "Abrindo…";
  const percentual = Math.round((posicao?.fraction ?? 0) * 100);

  // A mesma seleção que já vira "Novo destaque"/"Criar cartão" acima (ponto 4
  // do prompt desta rodada) — nenhuma segunda captura: `PainelDeVocabulario`
  // só recebe uma forma diferente do MESMO `selecaoPendente`. Sem `contexto`
  // próprio (a captura de seleção nunca extraiu a frase ao redor do trecho,
  // só o trecho em si), `texto` e `contexto` repetem o mesmo excerto.
  const selecaoParaVocabulario: SelecaoParaColeta | null = selecaoPendente
    ? { texto: selecaoPendente.excerpt, contexto: selecaoPendente.excerpt, locator: selecaoPendente.locatorStart }
    : null;

  function renderizarCorpo() {
    if (carregando) {
      return (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-ink-muted">Abrindo o livro…</p>
        </div>
      );
    }
    if (erroAbertura) {
      return (
        <div className="flex h-full items-center justify-center px-8">
          <p role="alert" className="max-w-sm text-center text-sm text-terracotta-ink">
            {erroAbertura}
          </p>
        </div>
      );
    }
    if (!livroAberto) return null;
    if (erroFormato) {
      return (
        <div className="flex h-full items-center justify-center px-8">
          <p role="alert" className="max-w-sm text-center text-sm text-terracotta-ink">
            {erroFormato}
          </p>
        </div>
      );
    }

    switch (livroAberto.livro.format) {
      case "pdf":
        return (
          <LeitorPdf
            ref={navegacaoRef}
            fonte={convertFileSrc(livroAberto.caminhoAbsoluto)}
            locatorInicial={livroAberto.progresso.currentLocator}
            hasTextLayer={livroAberto.livro.hasTextLayer}
            onVirarPagina={(nova) => void aoVirarPagina(nova)}
            onSelecaoDeTexto={aoSelecionarTexto}
            onErro={setErroFormato}
          />
        );
      case "epub":
        return (
          <LeitorEpub
            ref={navegacaoRef}
            fonte={convertFileSrc(livroAberto.caminhoAbsoluto)}
            locatorInicial={livroAberto.progresso.currentLocator}
            hasTextLayer={livroAberto.livro.hasTextLayer}
            onVirarPagina={(nova) => void aoVirarPagina(nova)}
            onSelecaoDeTexto={aoSelecionarTexto}
            onErro={setErroFormato}
          />
        );
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-3">
        <button
          type="button"
          onClick={onVoltar}
          className="shrink-0 rounded-sm px-2 py-1 text-sm text-ink-muted transition-transform motion-reduce:transition-none hover:text-ink active:scale-97"
        >
          ← Voltar para a estante
        </button>
        <h1 className="min-w-0 flex-1 truncate text-center font-display text-base text-ink">{titulo}</h1>
        <span aria-hidden="true" className="w-[6.5rem] shrink-0" />
      </header>

      {livroAberto && !erroAbertura ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-2">
          <button
            type="button"
            aria-label="Página anterior"
            onClick={() => navegacaoRef.current?.anterior()}
            className="rounded-sm px-2 py-1 text-sm text-ink-muted transition-transform motion-reduce:transition-none hover:bg-surface-sunken hover:text-ink active:scale-97"
          >
            ‹
          </button>
          <progress
            aria-label={`Progresso de leitura de ${titulo}`}
            value={percentual}
            max={100}
            className="h-1.5 w-full min-w-0 flex-1 overflow-hidden rounded-full bg-surface-sunken
              [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-surface-sunken
              [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-emerald"
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-muted">{percentual}%</span>
          <button
            type="button"
            aria-label="Próxima página"
            onClick={() => navegacaoRef.current?.proximo()}
            className="rounded-sm px-2 py-1 text-sm text-ink-muted transition-transform motion-reduce:transition-none hover:bg-surface-sunken hover:text-ink active:scale-97"
          >
            ›
          </button>
        </div>
      ) : null}

      {erroProgresso ? (
        <p role="alert" className="shrink-0 border-b border-hairline bg-surface-sunken px-4 py-1.5 text-center text-xs text-terracotta-ink">
          {erroProgresso}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">{renderizarCorpo()}</div>

        {livroAberto ? (
          <aside className="flex w-72 shrink-0 flex-col border-l border-hairline">
            {selecaoPendente ? (
              <div className="border-b border-hairline p-3">
                <p className="text-xs font-medium text-ink">Novo destaque</p>
                <p className="mt-1.5 line-clamp-3 rounded-sm bg-surface-sunken px-2 py-1.5 text-xs text-ink-muted">
                  “{selecaoPendente.excerpt}”
                </p>
                {/* Procedência como TEXTO, nunca um link: um trecho de livro não é
                    um bloco (`notes.source_block_id` referencia `blocks(id)`), então
                    não existe "ir para a origem" possível aqui — só o título e a
                    posição, que é o que o dado sustenta. */}
                <p className="mt-1 text-[11px] text-ink-muted">
                  de: {titulo} — {ROTULO_DO_LOCATOR[livroAberto.livro.format]} {selecaoPendente.locatorStart}
                </p>
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={abrirCriarCartao}
                    className="rounded-sm border border-border bg-surface px-2.5 py-1 text-xs text-ink transition hover:bg-surface-raised motion-reduce:transition-none active:scale-97"
                  >
                    Criar cartão
                  </button>
                </div>
                <div role="radiogroup" aria-label="Cor do destaque" className="mt-2 flex gap-2">
                  {CORES_DE_DESTAQUE.map((cor) => (
                    <button
                      key={cor}
                      type="button"
                      role="radio"
                      aria-checked={corRascunho === cor}
                      aria-label={`Cor ${cor}`}
                      onClick={() => setCorRascunho(cor)}
                      className={`size-5 rounded-full ${CLASSE_DA_COR[cor]} transition-transform motion-reduce:transition-none active:scale-90 ${
                        corRascunho === cor ? "ring-2 ring-focus ring-offset-1 ring-offset-surface" : ""
                      }`}
                    />
                  ))}
                </div>
                <label htmlFor="leitor-nota-destaque" className="mt-2 block text-xs text-ink-muted">
                  Nota (opcional)
                </label>
                <textarea
                  id="leitor-nota-destaque"
                  value={notaRascunho}
                  onChange={(event) => setNotaRascunho(event.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={cancelarDestaque}
                    className="rounded-sm px-2 py-1 text-xs text-ink-muted hover:text-ink"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={salvandoAnotacao}
                    onClick={() => void confirmarDestaque()}
                    className="rounded-sm bg-emerald px-2.5 py-1 text-xs font-medium text-on-emerald transition hover:brightness-110 motion-reduce:transition-none disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {salvandoAnotacao ? "Salvando…" : "Salvar destaque"}
                  </button>
                </div>
              </div>
            ) : null}

            {/* Os três painéis lado a lado num único scroll — mesmo padrão de
                lista com rolagem que cada painel já usa sozinho (`overflow-y-auto`
                na própria lista), só que agora compartilhado pela barra
                lateral inteira: nenhum padrão de abas/acordeão novo, cada
                painel continua autocontido e dirigido pelas mesmas props. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <PainelDeAnotacoes
                formato={livroAberto.livro.format}
                anotacoes={anotacoes}
                carregando={anotacoesCarregando}
                erro={anotacoesErro}
                onIrPara={aoIrParaAnotacao}
              />
              <div className="border-t border-hairline">
                <PainelDePaginas livroId={livroId} />
              </div>
              <div className="border-t border-hairline">
                <PainelDeVocabulario livroId={livroId} selecao={selecaoParaVocabulario} />
              </div>
            </div>
          </aside>
        ) : null}
      </div>

      {origemCartao ? (
        <CriarCartaoDeOrigem
          isOpen={cartaoAberto}
          origem={origemCartao}
          onClose={fecharCriarCartao}
          onCriado={aoCriarCartaoConcluido}
        />
      ) : null}
    </div>
  );
}
