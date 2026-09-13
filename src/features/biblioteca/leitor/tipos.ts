import type { Ref } from "react";

/**
 * A fronteira entre a casca do leitor e cada formato, escrita antes de o EPUB
 * existir — mesmo espírito de `src/features/editor/contract.ts`: diz o que um
 * leitor de formato PRECISA saber fazer, nada sobre COMO ele faz (paginar por
 * número no PDF, por CFI/scroll contínuo no EPUB).
 *
 * O que fica de fora daqui, de propósito, porque é comum aos dois formatos e
 * mora na própria casca (`LeitorDeLivro`): cabeçalho, "voltar para a
 * estante", a chamada a `registrarProgresso`, a lista de anotações e o
 * formulário de criar uma. Um componente de formato nunca chama IPC — ele só
 * relata o que aconteceu através destas props.
 */

/**
 * Onde a leitura está agora, no vocabulário do formato. `locator` é texto de
 * propósito (ver `Anotacao.locatorStart` em `lib/ipc.ts`) — número de página
 * no PDF, CFI no EPUB — e `fraction` é a mesma posição em 0..1, para a barra
 * de progresso da casca desenhar sem entender o locator.
 */
export interface PosicaoDeLeitura {
  locator: string;
  fraction: number;
}

/** Um trecho de texto selecionado pelo usuário, pronto para virar destaque. */
export interface SelecaoDeTexto {
  locatorStart: string;
  locatorEnd: string | null;
  fraction: number;
  excerpt: string;
}

/**
 * O que a casca pode pedir a um leitor de formato através do `ref` — o canal
 * inverso de `onVirarPagina`/`onErro`. Vive num `ref` (não em props) porque
 * quem decide "virar a página" é o teclado da casca (setas, PageUp/PageDown),
 * e um evento de teclado não tem estado próprio para carregar num re-render;
 * é a mesma razão de um `<video>` expor `.play()`/`.pause()` em vez de uma
 * prop `playing` que o pai teria que sincronizar a cada quadro.
 */
export interface NavegacaoDoLeitor {
  proximo(): void;
  anterior(): void;
  /**
   * Salta para `locator` no vocabulário do PRÓPRIO formato (número de página
   * em texto no PDF, CFI no EPUB) — usado ao clicar numa anotação da lista.
   *
   * Fase 2 (ajuste de contrato, PDF ajustado junto): a casca não sabe traduzir
   * um CFI para uma chamada de página, e um `irParaPagina(pagina: number)`
   * exigia que ELA fizesse essa tradução com `Number.parseInt` — o que
   * simplesmente não fazia sentido para `"epubcfi(/6/4!/4/2,/2/1:0,/4/2:15)"`
   * e silenciosamente virava no-op (`Number.isFinite` falso) para toda
   * anotação de EPUB. Cada formato agora resolve seu próprio texto opaco.
   */
  irParaLocator(locator: string): void;
  aumentarZoom(): void;
  diminuirZoom(): void;
  /**
   * Limpa a seleção de texto ATIVA do formato — cancelar/confirmar um
   * destaque precisa disso, e cada formato guarda sua seleção num documento
   * diferente: o PDF no `window` da própria página, o EPUB no `window` do
   * iframe de conteúdo que o epub.js monta (dois documentos distintos, dois
   * `Selection` distintos). A casca nunca sabe qual dos dois é o certo.
   */
  limparSelecao(): void;
}

/** As props que todo componente de formato recebe da casca. */
export interface PropsDoLeitorDeFormato {
  ref?: Ref<NavegacaoDoLeitor>;
  /** Já traduzido para uma URL que a WebView carrega — a casca resolve `convertFileSrc`, o formato nunca vê o caminho de disco cru. */
  fonte: string;
  /** `progresso.currentLocator` de `abrirLivro` — de onde a leitura deve reabrir. `null` quando o livro nunca foi aberto. */
  locatorInicial: string | null;
  /** `livro.hasTextLayer` do contrato. `false` desliga seleção de texto; `null` (nunca checado) tenta mesmo assim. */
  hasTextLayer: boolean | null;
  /** Chamado só numa virada de página DE FATO — nunca por evento de rolagem/zoom (ver ponto 5 do contrato). A casca grava isto via `registrarProgresso`. */
  onVirarPagina: (posicao: PosicaoDeLeitura) => void;
  /** `null` fecha um formulário de destaque já aberto (ex.: a seleção esvaziou). */
  onSelecaoDeTexto: (selecao: SelecaoDeTexto | null) => void;
  /** Uma mensagem pronta para o usuário — nunca uma exceção crua nem tela branca. */
  onErro: (mensagem: string) => void;
}
