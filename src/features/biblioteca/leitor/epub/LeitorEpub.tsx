import Epub, { type Book, type Contents, type Location as EpubLocation, type NavItem, type Rendition } from "epubjs";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { aplicarMarcacao } from "../marcacao-de-vocabulario";
import type { NavegacaoDoLeitor, PropsDoLeitorDeFormato } from "../tipos";

const ZOOM_MIN = 70;
const ZOOM_MAX = 200;
const ZOOM_PASSO = 10;
const ZOOM_PADRAO = 100;

// Mesma mensagem para as duas formas de "não consegui nem começar a abrir o
// livro" (o `fetch` do arquivo falhando, ou o epub.js emitindo "openFailed"
// depois de já ter os bytes) — a causa mais provável é a mesma nos dois casos
// (ver nota 4 do cabeçalho), então uma mensagem só, não duas quase-iguais.
const MENSAGEM_DE_FALHA_AO_ABRIR =
  "Não foi possível abrir o arquivo deste livro. Se você mudou a pasta de dados do " +
  "Learno recentemente, o app pode ainda não ter permissão para ler arquivos guardados " +
  "lá — feche e abra o Learno de novo, ou volte a pasta de dados para o padrão.";

// Granularidade dos "locais" que `book.locations.generate()` recorta pelo
// livro inteiro, em caracteres. O padrão da lib é 150 (fino, mais posições —
// mais lento); usar um valor maior aqui troca precisão de `fraction` por uma
// geração mais rápida, que é o que importa: o livro já está de fato aberto
// e navegável muito antes disso terminar (ver comentário em `iniciar`).
const CARACTERES_POR_LOCAL = 1000;

/**
 * Os documentos que estão desenhados agora. O `.d.ts` do epub.js declara
 * `getContents(): Contents`, mas `lib/rendition.js` devolve
 * `this.manager.getContents()`, que é uma LISTA (`lib/managers/default/index.js`,
 * um `Contents` por view montada) — conferido no `node_modules` instalado.
 * O tipo alargado aceita as duas formas sem cast.
 */
function conteudosDesenhados(rendition: Rendition): Contents[] {
  const retorno: Contents | Contents[] = rendition.getContents();
  return Array.isArray(retorno) ? retorno : [retorno];
}

/**
 * `document.body` pode ser `null` pela especificação, embora o lib.dom o
 * declare `HTMLElement`: um XHTML de EPUB sem `<body>` não pode derrubar o
 * hook de conteúdo do epub.js — uma exceção ali rejeita o `display()` da seção.
 */
function marcarConteudo(contents: Contents, termos: readonly string[]): void {
  const corpo: HTMLElement | null = contents.document.body;
  if (corpo) aplicarMarcacao(corpo, termos);
}

/** Um item do sumário e seus filhos, recursivo — a forma de `NavItem.subitems`. */
function ListaDoSumario({ itens, aoClicarItem }: { itens: NavItem[]; aoClicarItem: (href: string) => void }) {
  if (itens.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 pl-2 first:pl-0">
      {itens.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => aoClicarItem(item.href)}
            className="w-full truncate rounded-sm px-2 py-1 text-left text-xs text-ink transition-colors hover:bg-surface-raised"
            title={item.label.trim()}
          >
            {item.label.trim()}
          </button>
          {item.subitems && item.subitems.length > 0 ? (
            <ListaDoSumario itens={item.subitems} aoClicarItem={aoClicarItem} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * O caminho EPUB do leitor (ponto 1 do contrato, fase 2): renderiza com
 * `epubjs`, pagina dentro do capítulo, sumário clicável, reabre no CFI salvo
 * e vira destaque de texto selecionado.
 *
 * Implementa `PropsDoLeitorDeFormato`/`NavegacaoDoLeitor` (`../tipos.ts`), o
 * mesmo contrato de `LeitorPdf`; a casca (`LeitorDeLivro`) nunca importa
 * `epubjs` diretamente — só este arquivo sabe que o formato é EPUB.
 *
 * Três coisas verificadas em `node_modules/epubjs/lib/` antes de escrever
 * este arquivo (a biblioteca está parada desde set/2023 — a documentação por
 * si só não é confiável, ver AVISO 1 do prompt desta fase):
 *
 * 1. Quando `Epub(...)` falha ao abrir (buffer corrompido, por exemplo), o
 *    construtor de `Book` só EMITE
 *    `"openFailed"` — nunca rejeita `book.opened`/`book.ready`
 *    (`this.opening.reject` não existe em `book.js`). Um `await book.ready`
 *    sozinho deixaria esta tela em "Abrindo o EPUB…" para sempre num arquivo
 *    corrompido; por isso o erro real vem do listener do evento, não de um
 *    `.catch()`.
 * 2. O mesmo vale para `rendition.display()`: se o MANAGER falha ao desenhar
 *    a seção (evento `"displayerror"`), a Promise que `display()` devolve
 *    nunca é rejeitada — só o `"No Section Found"` (locator inexistente) de
 *    fato rejeita. Por isso o listener de `"displayerror"` existe ao lado do
 *    `.catch()`.
 * 3. `Locations.percentageFromCfi` devolve `null` quando `generate()` ainda
 *    não terminou, embora o `.d.ts` declare `number` sem `| null` — conferido
 *    em `lib/locations.js`. O `?? 0` abaixo não é defesa por paranoia; é a
 *    única forma de não propagar `null` para um contrato que promete
 *    `fraction: number`.
 * 4. Por que `fetch(fonte)` + `Epub(arrayBuffer)`, em vez de `Epub(fonte)`
 *    direto (investigação do bug reportado como "EPUB bugado" — nenhuma
 *    reprodução em WebView de verdade, só o que ficou provado lendo
 *    `node_modules/epubjs/lib/book.js` e `tauri.conf.json`):
 *    - `Epub(url)` com uma URL terminada em `.epub` já baixa o arquivo
 *      INTEIRO de uma vez (`INPUT_TYPE.EPUB` em `determineType`, `book.js`
 *      linha ~267) — não é um XHR por recurso interno, é UM fetch do zip.
 *      Isso já atravessa `connect-src` do CSP, e `http://asset.localhost`
 *      já está listado lá (`tauri.conf.json`) — então esse fetch, feito
 *      pela própria lib ou por nós, não é o que está quebrado hoje.
 *    - Passar o `ArrayBuffer` em vez da URL string tira essa ÚNICA busca de
 *      dentro do request interno da lib (que só reporta falha via evento,
 *      nunca detalha status HTTP) e coloca na nossa mão, com `fetch()`
 *      normal — mensagem de erro melhor, e um ponto a menos que depende do
 *      `assetProtocol.scope` continuar cobrindo o arquivo se a pasta de
 *      dados mudar (mesma armadilha que `LeitorPdf.tsx` já documenta).
 *    - O QUE ISTO NÃO CONSERTA: com `.epub` (zip), `book.archived` fica
 *      `true` de qualquer jeito — URL ou buffer, tanto faz — e o epub.js
 *      troca sozinho para `replacements: "blobUrl"` (`book.js` linha ~487):
 *      toda imagem, fonte e CSS externo do capítulo vira uma URL `blob:`
 *      (`lib/resources.js`). `tauri.conf.json` hoje permite `blob:` em
 *      NENHUM de `img-src`/`style-src`/`font-src` — só o texto inline do
 *      capítulo (que vai por `srcdoc`, não por `blob:`) tem chance de
 *      aparecer; imagem, CSS externo e fonte embutida no EPUB ficam
 *      bloqueados pelo CSP independente desta mudança. Esse arquivo não
 *      edita `tauri.conf.json` (fora de escopo desta tarefa) — fica
 *      registrado aqui para quem for mexer lá.
 */
export function LeitorEpub({
  ref,
  fonte,
  locatorInicial,
  // `hasTextLayer` é conceito de PDF (documento escaneado sem texto por
  // baixo das imagens). Todo EPUB é HTML — o texto é sempre selecionável —
  // então esta prop não tem o que fazer aqui, de propósito.
  onVirarPagina,
  onSelecaoDeTexto,
  onErro,
  termosMarcados,
}: PropsDoLeitorDeFormato) {
  const [carregando, setCarregando] = useState(true);
  const [sumario, setSumario] = useState<NavItem[]>([]);
  const [sumarioAberto, setSumarioAberto] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(ZOOM_PADRAO);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  // A seleção de texto do usuário vive no `window` do iframe de conteúdo que
  // o epub.js monta — nunca no `window` desta página. Guardamos o `Contents`
  // de onde a seleção ativa veio para `limparSelecao` saber qual documento
  // limpar (ver `NavegacaoDoLeitor.limparSelecao` em `../tipos.ts`).
  const contentsAtivaRef = useRef<Contents | null>(null);

  // Mesma razão de `LeitorPdf`: estas props são lidas de dentro de um efeito
  // que só deve reabrir o livro quando `fonte` muda, nunca porque o pai
  // renderizou de novo com uma função recriada.
  const onErroRef = useRef(onErro);
  onErroRef.current = onErro;
  const onVirarPaginaRef = useRef(onVirarPagina);
  onVirarPaginaRef.current = onVirarPagina;
  const onSelecaoDeTextoRef = useRef(onSelecaoDeTexto);
  onSelecaoDeTextoRef.current = onSelecaoDeTexto;
  const locatorInicialRef = useRef(locatorInicial);
  locatorInicialRef.current = locatorInicial;
  // Lido pelo `hooks.content`, que é registrado UMA vez por livro: cada seção
  // nova que o epub.js desenha precisa nascer com a lista de agora, não com a
  // de quando o livro abriu.
  const termosMarcadosRef = useRef(termosMarcados);
  termosMarcadosRef.current = termosMarcados;

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelado = false;
    // `book` só existe depois que o `fetch` abaixo resolve — antes disso
    // não há nada para `off`/`destroy` no cleanup se o componente desmontar
    // no meio da busca do arquivo.
    let book: Book | null = null;

    function aoFalharAbertura() {
      if (cancelado) return;
      onErroRef.current(MENSAGEM_DE_FALHA_AO_ABRIR);
    }

    async function iniciar() {
      let bufferDoLivro: ArrayBuffer;
      try {
        // `fetch`, não o request interno do epub.js: mesmo caminho de rede
        // (`connect-src` do CSP, `assetProtocol.scope`), mas com uma falha
        // que dá pra checar (`response.ok`) em vez de só um evento sem
        // detalhe (ver nota 4 do cabeçalho).
        const resposta = await fetch(fonte);
        if (!resposta.ok) throw new Error(`HTTP ${resposta.status} ao ler ${fonte}`);
        bufferDoLivro = await resposta.arrayBuffer();
      } catch {
        aoFalharAbertura();
        return;
      }
      if (cancelado || !containerRef.current) return;

      // `livro` (não `book` direto) daqui pra baixo: `book` é `let` no
      // escopo do efeito (o cleanup precisa dele antes de existir), e
      // TypeScript não propaga o narrowing de uma variável mutável para
      // dentro dos callbacks abaixo — `livro` é `const`, sempre `Book`.
      const livro = Epub(bufferDoLivro);
      book = livro;
      livro.on("openFailed", aoFalharAbertura);

      await livro.ready;
      // `book.ready` nunca de fato rejeita (ver nota 1 do cabeçalho) — o
      // guard abaixo é só para o caso de o componente ter desmontado
      // enquanto esperava.
      if (cancelado || !containerRef.current) return;

      const rendition = livro.renderTo(containerRef.current, {
        width: "100%",
        height: "100%",
        flow: "paginated",
        // Um único bloco de coluna por vez: é o que faz "virar página" ter
        // um instante único e óbvio para gravar progresso, mesma razão de
        // `LeitorPdf` mostrar uma página por vez em vez de scroll contínuo.
        spread: "none",
      });
      renditionRef.current = rendition;

      function aoFalharExibicao() {
        if (cancelado) return;
        onErroRef.current("Não foi possível abrir esta parte do livro. Feche e abra o livro de novo.");
      }
      rendition.on("displayerror", aoFalharExibicao);

      rendition.on("relocated", (location: EpubLocation) => {
        if (cancelado) return;
        setCarregando(false);
        const cfi = location.start.cfi;
        const fraction = livro.locations.percentageFromCfi(cfi) ?? 0;
        onVirarPaginaRef.current({ locator: cfi, fraction });
      });

      // Cada seção do EPUB é desenhada no `document` de um iframe próprio —
      // é aqui que o epub.js nos dá acesso a ele. Replicamos a mesma
      // detecção de "seleção esvaziou" que `LeitorPdf` faz no seu próprio
      // `document`: sem isto, fechar a seleção (clicar em outro lugar do
      // texto) nunca fecharia o formulário de destaque pendente.
      rendition.hooks.content.register((contents: Contents) => {
        function aoMudarSelecao() {
          const selecao = contents.window.getSelection();
          if (!selecao || selecao.isCollapsed) {
            if (contentsAtivaRef.current === contents) contentsAtivaRef.current = null;
            onSelecaoDeTextoRef.current(null);
          }
        }
        contents.document.addEventListener("selectionchange", aoMudarSelecao);
        // Seção nova = documento novo, com registro de destaques próprio (o
        // `window` do iframe): o que foi marcado na seção anterior não vem junto.
        marcarConteudo(contents, termosMarcadosRef.current);
      });

      // O epub.js só emite "selected" quando a seleção já não está vazia
      // (debounced 250ms dentro da própria lib — ver `contents.js`), então
      // nenhum debounce extra é necessário aqui.
      rendition.on("selected", (cfiRange: string, contents: Contents) => {
        if (cancelado) return;
        const excerto = contents.window.getSelection()?.toString().trim();
        if (!excerto) return;
        contentsAtivaRef.current = contents;
        // Dois fallbacks encadeados, cada um por um motivo verificado
        // diferente (nenhum dos dois é "?? até parar de quebrar" por
        // preguiça): `percentageFromCfi` devolve `null` antes de
        // `locations.generate()` terminar (nota 3 do cabeçalho); e
        // `rendition.location` — que o `.d.ts` declara como sempre presente
        // — só é populado depois do primeiro `reportLocation()` de verdade
        // (`rendition.js`, campo iniciado `undefined` no construtor). Uma
        // seleção feita ANTES de qualquer virada de página cai no `?? 0`
        // final; uma anotação criada no meio do livro não deveria nascer
        // marcada no início da barra por isso.
        const fraction = livro.locations.percentageFromCfi(cfiRange) ?? rendition.location?.start.percentage ?? 0;
        onSelecaoDeTextoRef.current({ locatorStart: cfiRange, locatorEnd: null, fraction, excerpt: excerto });
      });

      setSumario(livro.navigation.toc);

      try {
        await rendition.display(locatorInicialRef.current ?? undefined);
      } catch {
        // O CFI salvo não bate mais com este arquivo (ex.: outra edição do
        // mesmo EPUB) — degrada para o início em vez de travar a leitura
        // inteira, mesmo espírito de `clamparPagina` em `LeitorPdf`.
        try {
          await rendition.display();
        } catch {
          if (!cancelado) onErroRef.current("Não foi possível abrir este EPUB.");
          return;
        }
      }
      if (!cancelado) setCarregando(false);

      // Em segundo plano, nunca bloqueando a leitura: sem isto,
      // `percentageFromCfi` fica preso em 0 pelo livro inteiro (ponto 3 do
      // contrato — fraction pra desenhar a barra de progresso).
      void livro.locations.generate(CARACTERES_POR_LOCAL);
    }

    void iniciar();

    return () => {
      cancelado = true;
      // `book` pode ainda ser `null` aqui (desmontou durante o `fetch`,
      // antes de `Epub()` ser chamado) — daí o optional chaining nos dois.
      book?.off("openFailed", aoFalharAbertura);
      renditionRef.current?.destroy();
      renditionRef.current = null;
      book?.destroy();
    };
  }, [fonte]);

  useEffect(() => {
    renditionRef.current?.themes.fontSize(`${zoomPercent}%`);
  }, [zoomPercent]);

  // Marcador ligado/desligado ou palavra colhida: remarca o que já está na
  // tela, sem esperar a próxima seção. Antes da rendition existir não há o que
  // remarcar — a primeira seção já nasce marcada pelo `hooks.content`.
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    for (const contents of conteudosDesenhados(rendition)) marcarConteudo(contents, termosMarcados);
  }, [termosMarcados]);

  useImperativeHandle(
    ref,
    (): NavegacaoDoLeitor => ({
      proximo: () => void renditionRef.current?.next(),
      anterior: () => void renditionRef.current?.prev(),
      irParaLocator: (locator) => void renditionRef.current?.display(locator),
      aumentarZoom: () => setZoomPercent((atual) => Math.min(ZOOM_MAX, atual + ZOOM_PASSO)),
      diminuirZoom: () => setZoomPercent((atual) => Math.max(ZOOM_MIN, atual - ZOOM_PASSO)),
      limparSelecao: () => {
        contentsAtivaRef.current?.window.getSelection()?.removeAllRanges();
        contentsAtivaRef.current = null;
      },
    }),
    [],
  );

  function aoClicarItemDoSumario(href: string) {
    void renditionRef.current?.display(href);
    setSumarioAberto(false);
  }

  return (
    <div className="relative flex h-full flex-col">
      {carregando ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface">
          <p className="text-sm text-ink-muted">Abrindo o EPUB…</p>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {sumarioAberto ? (
          <aside aria-label="Sumário" className="w-56 shrink-0 overflow-y-auto border-r border-hairline bg-surface-sunken p-2">
            {sumario.length === 0 ? (
              <p className="px-1 py-1 text-xs text-ink-muted">Este livro não tem sumário.</p>
            ) : (
              <ListaDoSumario itens={sumario} aoClicarItem={aoClicarItemDoSumario} />
            )}
          </aside>
        ) : null}

        {/* epub.js monta o iframe de conteúdo dentro deste container — ele
            nunca é o alvo de `dangerouslySetInnerHTML` nem de manipulação de
            DOM nossa; é `book.renderTo` que controla o que entra aqui. */}
        <div ref={containerRef} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
      </div>

      <div className="flex shrink-0 items-center justify-center gap-4 border-t border-hairline px-4 py-2">
        <button
          type="button"
          aria-pressed={sumarioAberto}
          onClick={() => setSumarioAberto((atual) => !atual)}
          className="rounded-sm px-2 py-0.5 text-xs text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
        >
          Sumário
        </button>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Diminuir fonte"
            onClick={() => setZoomPercent((atual) => Math.max(ZOOM_MIN, atual - ZOOM_PASSO))}
            disabled={zoomPercent <= ZOOM_MIN}
            className="rounded-sm px-2 py-0.5 text-sm text-ink-muted transition-transform motion-reduce:transition-none hover:bg-surface-sunken hover:text-ink active:scale-97 disabled:opacity-40 disabled:pointer-events-none"
          >
            −
          </button>
          <span className="w-10 text-center text-xs tabular-nums text-ink-muted">{zoomPercent}%</span>
          <button
            type="button"
            aria-label="Aumentar fonte"
            onClick={() => setZoomPercent((atual) => Math.min(ZOOM_MAX, atual + ZOOM_PASSO))}
            disabled={zoomPercent >= ZOOM_MAX}
            className="rounded-sm px-2 py-0.5 text-sm text-ink-muted transition-transform motion-reduce:transition-none hover:bg-surface-sunken hover:text-ink active:scale-97 disabled:opacity-40 disabled:pointer-events-none"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
