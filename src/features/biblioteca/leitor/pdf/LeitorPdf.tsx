import { useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  GlobalWorkerOptions,
  RenderingCancelledException,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
// A ARMADILHA desta peça: o caminho do worker tem que vir do bundle do
// próprio Vite (`?url` resolve para o asset final, com hash, e o `vite
// build` o copia para `dist/assets/`) — nunca de um CDN. Não há internet
// garantida num app local, e um script externo carregado por um app desktop
// é superfície de ataque que o CSP do projeto (`script-src 'self'`) recusaria
// de qualquer jeito. `rtk proxy npx vite build` precisa confirmar que este
// asset aparece no bundle — é o achado mais importante desta peça se faltar.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { NavegacaoDoLeitor, PropsDoLeitorDeFormato } from "../tipos";
import "./text-layer.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_PASSO = 0.2;
const ZOOM_PADRAO = 1.2;

/** `locator` de PDF é o número da página, em texto (ver `tipos.ts`). `null`/inválido = livro nunca aberto, começa na primeira. */
function paginaInicialDoLocator(locator: string | null): number {
  if (!locator) return 1;
  const numero = Number.parseInt(locator, 10);
  return Number.isFinite(numero) && numero >= 1 ? numero : 1;
}

/** `getPage` do pdf.js conta do 1 — nunca 0, nunca acima do total do documento. */
function clamparPagina(pagina: number, totalDePaginas: number): number {
  return Math.min(Math.max(pagina, 1), Math.max(totalDePaginas, 1));
}

function fracaoDaPagina(pagina: number, totalDePaginas: number): number {
  if (totalDePaginas <= 0) return 0;
  return Math.min(1, pagina / totalDePaginas);
}

function arredondarZoom(valor: number): number {
  return Math.round(valor * 100) / 100;
}

/**
 * O caminho PDF do leitor: um visualizador de uma página por vez (não
 * scroll contínuo) — é o que faz `locator` ser literalmente o número da
 * página, sem tradução, e "virar página" ter um instante único e óbvio para
 * gravar progresso (ponto 5 do contrato).
 *
 * Implementa `PropsDoLeitorDeFormato`/`NavegacaoDoLeitor` (`../tipos.ts`); a
 * casca (`LeitorDeLivro`) nunca importa `pdfjs-dist` diretamente — só este
 * arquivo sabe que o formato é PDF.
 */
export function LeitorPdf({
  ref,
  fonte,
  locatorInicial,
  hasTextLayer,
  onVirarPagina,
  onSelecaoDeTexto,
  onErro,
}: PropsDoLeitorDeFormato) {
  const [documento, setDocumento] = useState<PDFDocumentProxy | null>(null);
  const [carregandoDocumento, setCarregandoDocumento] = useState(true);
  const [paginaAtual, setPaginaAtual] = useState(() => paginaInicialDoLocator(locatorInicial));
  const [zoom, setZoom] = useState(ZOOM_PADRAO);
  const [renderizandoPagina, setRenderizandoPagina] = useState(false);
  const [entradaDePagina, setEntradaDePagina] = useState(String(paginaInicialDoLocator(locatorInicial)));

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paginaWrapperRef = useRef<HTMLDivElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  // As três props de callback são lidas por dentro de efeitos que não devem
  // reexecutar só porque o pai renderizou de novo com uma função recriada —
  // reabrir o documento inteiro a cada tecla digitada em outro canto da tela
  // seria o bug. O ref pega sempre a versão mais nova sem entrar em nenhuma
  // lista de dependências.
  const onErroRef = useRef(onErro);
  onErroRef.current = onErro;
  const onVirarPaginaRef = useRef(onVirarPagina);
  onVirarPaginaRef.current = onVirarPagina;
  const onSelecaoDeTextoRef = useRef(onSelecaoDeTexto);
  onSelecaoDeTextoRef.current = onSelecaoDeTexto;

  const permiteSelecao = hasTextLayer !== false;

  useEffect(() => {
    setEntradaDePagina(String(paginaAtual));
  }, [paginaAtual]);

  // Carrega o documento quando a fonte muda (nunca deveria mudar depois do
  // primeiro render — `LeitorDeLivro` monta uma instância por livro — mas a
  // dependência é a fonte da verdade mesmo assim).
  useEffect(() => {
    let cancelado = false;
    setCarregandoDocumento(true);
    setDocumento(null);
    const tarefa = getDocument({ url: fonte });

    tarefa.promise
      .then((doc) => {
        if (cancelado) return;
        setDocumento(doc);
        setCarregandoDocumento(false);
        setPaginaAtual((atual) => clamparPagina(atual, doc.numPages));
      })
      .catch(() => {
        if (cancelado) return;
        setCarregandoDocumento(false);
        // A ARMADILHA CONHECIDA do contrato: se `save_data_dir` mudou a pasta
        // de dados, o escopo estático de `assetProtocol` (`$APPDATA/media/**`)
        // pode não cobrir mais o arquivo, e este `getDocument` rejeita sem
        // detalhe utilizável. Uma mensagem genérica de rede seria pior que
        // esta, que pelo menos aponta a causa mais provável.
        onErroRef.current(
          "Não foi possível abrir o arquivo deste livro. Se você mudou a pasta de dados do " +
            "Learno recentemente, o app pode ainda não ter permissão para ler arquivos guardados " +
            "lá — feche e abra o Learno de novo, ou volte a pasta de dados para o padrão.",
        );
      });

    return () => {
      cancelado = true;
      void tarefa.destroy();
    };
  }, [fonte]);

  // Renderiza a página atual (canvas + camada de texto) sempre que a página
  // ou o zoom mudam. Cancela um render em voo antes de começar outro — sem
  // isto, virar duas páginas rápido faz o pdf.js rejeitar o segundo render
  // com "already rendering".
  useEffect(() => {
    if (!documento) return;
    let cancelado = false;
    setRenderizandoPagina(true);

    async function renderizar() {
      const doc = documento;
      if (!doc) return;
      const pagina = await doc.getPage(paginaAtual);
      if (cancelado) return;
      const viewport = pagina.getViewport({ scale: zoom });

      const canvas = canvasRef.current;
      if (canvas) {
        // Backing store em resolução real do monitor (`devicePixelRatio`);
        // o tamanho CSS fica no da viewport lógica — é o que evita PDF
        // borrado numa tela HiDPI.
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const transform = outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0];

        if (paginaWrapperRef.current) {
          paginaWrapperRef.current.style.width = `${viewport.width}px`;
          paginaWrapperRef.current.style.height = `${viewport.height}px`;
          // Lido por `text-layer.css` (`--total-scale-factor`) para o
          // tamanho de cada span de texto acompanhar este mesmo zoom.
          paginaWrapperRef.current.style.setProperty("--scale-factor", String(viewport.scale));
        }

        const tarefaRender = pagina.render({ canvas, viewport, transform });
        renderTaskRef.current = tarefaRender;
        await tarefaRender.promise;
      }
      if (cancelado) return;

      const containerTexto = textLayerRef.current;
      if (containerTexto) {
        containerTexto.replaceChildren();
        if (permiteSelecao) {
          const textContent = await pagina.getTextContent();
          if (cancelado) return;
          await new TextLayer({ textContentSource: textContent, container: containerTexto, viewport }).render();
        }
      }

      if (!cancelado) setRenderizandoPagina(false);
    }

    renderizar().catch((error: unknown) => {
      if (cancelado) return;
      setRenderizandoPagina(false);
      // Esperado sempre que uma página nova chega no meio de um render em
      // voo (o cleanup abaixo cancela a tarefa) — não é erro para o usuário.
      if (error instanceof RenderingCancelledException) return;
      onErroRef.current("Não foi possível desenhar esta página. Tente ir para outra página e voltar.");
    });

    return () => {
      cancelado = true;
      renderTaskRef.current?.cancel();
    };
  }, [documento, paginaAtual, zoom, permiteSelecao]);

  // A seleção de texto do usuário vira candidata a destaque — só quando cai
  // dentro da camada de texto DESTA página (um clique/arrasto em qualquer
  // outra parte da tela, inclusive fora do leitor, limpa a seleção pendente).
  useEffect(() => {
    if (!permiteSelecao) return;

    function tratarSelecao() {
      const selecao = window.getSelection();
      const container = textLayerRef.current;
      if (!selecao || !container || selecao.isCollapsed || selecao.rangeCount === 0) {
        onSelecaoDeTextoRef.current(null);
        return;
      }
      const intervalo = selecao.getRangeAt(0);
      if (!container.contains(intervalo.commonAncestorContainer)) {
        onSelecaoDeTextoRef.current(null);
        return;
      }
      const excerto = selecao.toString().trim();
      if (!excerto) {
        onSelecaoDeTextoRef.current(null);
        return;
      }
      const locator = String(paginaAtual);
      onSelecaoDeTextoRef.current({
        locatorStart: locator,
        locatorEnd: locator,
        fraction: fracaoDaPagina(paginaAtual, documento?.numPages ?? paginaAtual),
        excerpt: excerto,
      });
    }

    document.addEventListener("selectionchange", tratarSelecao);
    return () => document.removeEventListener("selectionchange", tratarSelecao);
  }, [paginaAtual, documento, permiteSelecao]);

  function irPara(paginaAlvo: number) {
    if (!documento) return;
    const novaPagina = clamparPagina(paginaAlvo, documento.numPages);
    // No-op nas bordas (já na primeira/última página): sem isto, segurar
    // "próxima" na última página gravaria progresso idêntico ao infinito.
    if (novaPagina === paginaAtual) return;
    setPaginaAtual(novaPagina);
    onVirarPaginaRef.current({ locator: String(novaPagina), fraction: fracaoDaPagina(novaPagina, documento.numPages) });
  }

  useImperativeHandle(
    ref,
    (): NavegacaoDoLeitor => ({
      proximo: () => irPara(paginaAtual + 1),
      anterior: () => irPara(paginaAtual - 1),
      // `locator` de PDF é o número da página em texto — mesmo vocabulário
      // de `paginaInicialDoLocator`. Um locator não numérico (não deveria
      // acontecer para um PDF, mas o valor cruza o IPC como `string` livre)
      // é no-op, nunca um crash.
      irParaLocator: (locator) => {
        const pagina = Number.parseInt(locator, 10);
        if (Number.isFinite(pagina)) irPara(pagina);
      },
      aumentarZoom: () => setZoom((atual) => Math.min(ZOOM_MAX, arredondarZoom(atual + ZOOM_PASSO))),
      diminuirZoom: () => setZoom((atual) => Math.max(ZOOM_MIN, arredondarZoom(atual - ZOOM_PASSO))),
      limparSelecao: () => window.getSelection()?.removeAllRanges(),
    }),
    [documento, paginaAtual],
  );

  function confirmarEntradaDePagina() {
    const numero = Number.parseInt(entradaDePagina, 10);
    if (Number.isFinite(numero)) irPara(numero);
    else setEntradaDePagina(String(paginaAtual));
  }

  if (carregandoDocumento) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-ink-muted">Abrindo o PDF…</p>
      </div>
    );
  }

  if (!documento) return null;

  return (
    <div className="flex h-full flex-col">
      {!permiteSelecao ? (
        <p className="shrink-0 border-b border-hairline bg-surface-sunken px-4 py-1.5 text-center text-xs text-ink-muted">
          Este PDF não tem texto reconhecível — busca, grifo e criação de cartão por seleção não funcionam aqui.
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-6">
        <div ref={paginaWrapperRef} className="leitor-pdf-pagina shrink-0 shadow-hard">
          <canvas ref={canvasRef} aria-hidden="true" className="block" />
          <div
            ref={textLayerRef}
            className="leitor-pdf-text-layer"
            data-sem-texto={permiteSelecao ? undefined : "true"}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-4 border-t border-hairline px-4 py-2">
        <div className="flex items-center gap-1.5">
          <label htmlFor="leitor-pdf-pagina-input" className="text-xs text-ink-muted">
            Página
          </label>
          <input
            id="leitor-pdf-pagina-input"
            type="text"
            inputMode="numeric"
            value={entradaDePagina}
            onChange={(event) => setEntradaDePagina(event.target.value)}
            onBlur={confirmarEntradaDePagina}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              confirmarEntradaDePagina();
            }}
            className="w-12 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-center text-xs text-ink"
          />
          <span className="text-xs text-ink-muted">de {documento.numPages}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Diminuir zoom"
            onClick={() => setZoom((atual) => Math.max(ZOOM_MIN, arredondarZoom(atual - ZOOM_PASSO)))}
            disabled={zoom <= ZOOM_MIN}
            className="rounded-sm px-2 py-0.5 text-sm text-ink-muted transition-transform motion-reduce:transition-none hover:bg-surface-sunken hover:text-ink active:scale-97 disabled:opacity-40 disabled:pointer-events-none"
          >
            −
          </button>
          <span className="w-10 text-center text-xs tabular-nums text-ink-muted">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            aria-label="Aumentar zoom"
            onClick={() => setZoom((atual) => Math.min(ZOOM_MAX, arredondarZoom(atual + ZOOM_PASSO)))}
            disabled={zoom >= ZOOM_MAX}
            className="rounded-sm px-2 py-0.5 text-sm text-ink-muted transition-transform motion-reduce:transition-none hover:bg-surface-sunken hover:text-ink active:scale-97 disabled:opacity-40 disabled:pointer-events-none"
          >
            +
          </button>
        </div>

        {renderizandoPagina ? <span className="text-xs text-ink-muted">Desenhando…</span> : null}
      </div>
    </div>
  );
}
