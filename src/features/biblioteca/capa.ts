/**
 * Extrai e persiste a capa de um livro — PARTE 4 do contrato desta rodada: a
 * extração roda DEPOIS de o livro já estar na estante (`store.ts`, ao
 * terminar `importar`, e sob demanda para livro já importado sem capa), e
 * NUNCA pode atrasar nem quebrar essa importação.
 *
 * PDF: desenha a primeira página com `pdfjs-dist` num canvas e exporta PNG —
 * mesma configuração de worker de `leitor/pdf/LeitorPdf.tsx` (o comentário lá
 * explica por que o asset tem que vir do bundle do Vite; reaproveitada aqui
 * ao pé da letra, nunca configurada de outro jeito).
 *
 * EPUB: usa a capa que o próprio arquivo declara (`book.coverUrl()`), a
 * mesma lib que `leitor/epub/LeitorEpub.tsx` já verificou contra o código-
 * fonte (`node_modules/epubjs/lib/book.js`) — inclusive a armadilha
 * documentada lá de `book.ready` nunca rejeitar quando a abertura falha (só
 * o evento `"openFailed"` avisa).
 *
 * O requisito mais importante desta peça: falhar em extrair NUNCA pode
 * quebrar a importação nem travar a estante. PDF corrompido, EPUB sem capa
 * embutida, canvas que não exporta — tudo termina em `null` ("sem capa"),
 * nunca numa exceção.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import Epub from "epubjs";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { storeMediaFile } from "../editor/blocks/media/media-storage";
import { abrirLivro, definirCapaDoLivro, type LivroAberto } from "../../lib/ipc";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Um pouco acima de 1x: nitidez razoável no cartão da estante sem gerar um PNG gigante para um PDF em página grande. */
const ESCALA_DA_CAPA = 1.5;

async function extrairCapaDoPdf(fonte: string): Promise<File | null> {
  const tarefa = getDocument({ url: fonte });
  try {
    const documento: PDFDocumentProxy = await tarefa.promise;
    const pagina = await documento.getPage(1);
    const viewport = pagina.getViewport({ scale: ESCALA_DA_CAPA });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    await pagina.render({ canvas, viewport }).promise;

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob || blob.size === 0) return null;
    return new File([blob], "capa.png", { type: "image/png" });
  } catch {
    // PDF corrompido, página 1 ausente, canvas que não exporta — tudo aqui
    // vira "sem capa", nunca uma exceção que travaria a importação.
    return null;
  } finally {
    // `PDFDocumentProxy` (o documento resolvido) não tem `.destroy()` nesta
    // versão do pdfjs-dist — quem limpa é a TAREFA de carregamento, mesmo
    // objeto que `LeitorPdf.tsx` destrói no cleanup do seu efeito.
    await tarefa.destroy();
  }
}

async function extrairCapaDoEpub(fonte: string): Promise<File | null> {
  // `fetch` + `ArrayBuffer`, e não `Epub(url)`: exatamente o que
  // `leitor/epub/LeitorEpub.tsx` faz (ver a nota 4 do cabeçalho de lá). Este
  // arquivo tinha ficado no caminho antigo, por URL, e por isso o cartão do
  // EPUB continuava sem capa enquanto o do PDF já tinha. Um `fetch` normal
  // também dá uma falha inspecionável (`response.ok`) em vez de só o evento
  // sem detalhe que a lib emite.
  let buffer: ArrayBuffer;
  try {
    const resposta = await fetch(fonte);
    if (!resposta.ok) return null;
    buffer = await resposta.arrayBuffer();
  } catch {
    return null;
  }

  const book = Epub(buffer);
  try {
    // ARMADILHA verificada em `LeitorEpub.tsx` (nota 1 do cabeçalho de lá):
    // se `open()` falhar, `book.ready` nunca resolve nem rejeita — só o
    // evento "openFailed" dispara. Sem esta corrida, um EPUB corrompido
    // travaria esta extração para sempre, em vez de terminar em "sem capa".
    const abriu = await Promise.race<boolean>([
      book.ready.then(() => true),
      new Promise<boolean>((resolve) => book.once("openFailed", () => resolve(false))),
    ]);
    if (!abriu) return null;

    const urlDaCapa = await book.coverUrl();
    if (!urlDaCapa) return null;

    const resposta = await fetch(urlDaCapa);
    if (!resposta.ok) return null;
    const blob = await resposta.blob();
    if (blob.size === 0) return null;
    return new File([blob], "capa.png", { type: blob.type || "image/jpeg" });
  } catch {
    return null;
  } finally {
    book.destroy();
  }
}

/** Recebe um livro já aberto (`abrirLivro`) e devolve os bytes da capa, ou `null` quando não há capa a extrair — nunca lança. */
export async function extrairCapaDoLivro(livroAberto: LivroAberto): Promise<File | null> {
  const fonte = convertFileSrc(livroAberto.caminhoAbsoluto);
  switch (livroAberto.livro.format) {
    case "pdf":
      return extrairCapaDoPdf(fonte);
    case "epub":
      return extrairCapaDoEpub(fonte);
  }
}

/**
 * Extrai a capa de `livroId` e a persiste pelo MESMO armazenamento de mídia
 * dos blocos do editor (`storeMediaFile`) — nunca um segundo mecanismo de
 * arquivo. Devolve o `coverFileName` gravado (para quem chamou atualizar a
 * estante em memória sem recarregar a lista inteira), ou `null` quando não
 * há capa para gravar — extração falhou, ou o livro sumiu da pasta de mídia
 * entre a importação e esta chamada. Nesse caso nada é escrito, nem em
 * `media/` nem no banco.
 */
export async function gerarCapaDoLivro(livroId: string): Promise<string | null> {
  try {
    const livroAberto = await abrirLivro(livroId);
    const arquivo = await extrairCapaDoLivro(livroAberto);
    if (!arquivo) return null;
    const armazenada = await storeMediaFile(arquivo);
    await definirCapaDoLivro(livroId, armazenada.src);
    return armazenada.src;
  } catch {
    // Mesmo requisito da extração: um `abrirLivro` que falha (arquivo sumiu
    // da pasta de mídia) ou um `definirCapaDoLivro` que rejeita (erro
    // transitório do backend) não pode derrubar quem chamou — a capa é um
    // extra, nunca um requisito para o livro aparecer na estante.
    return null;
  }
}
