/**
 * O bloco de código (EDT-018): estende `CodeBlockLowlight` trocando
 * `group: "block"` por `"blockContent"` e mantendo o resto - senão o nó
 * nasceria fora do wrapper `Block` (README, "Blocos ricos") e seria
 * descartado em silêncio ao salvar. Conteúdo continua `"text*"`/`marks: ""`
 * do nó original (herdado, não redeclarado aqui) - uma forma de conteúdo
 * diferente de `"inline* childBlocks?"` de propósito: um bloco de código não
 * aninha filhos, então não precisa (nem quer) da indentação genérica de
 * Tab/Shift-Tab que os nove tipos estruturais ganham de graça (README,
 * "Onde não esperar generalidade") - ele já tem a própria, ativada abaixo.
 */
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { codeBlockNodeView } from "./code-block-view";
import { codeLowlight, DEFAULT_CODE_LANGUAGE } from "./languages";

// Mesmo default de `@tiptap/extension-code-block` (`DEFAULT_TAB_SIZE`, não
// exportado por lá) - nomeado aqui só para não hardcodar um "4" solto.
const PARENT_DEFAULT_TAB_SIZE = 4;

export const CodeBlock = CodeBlockLowlight.extend({
  group: "blockContent",
  addOptions() {
    // `...this.parent?.()` sozinho faz o TS enxergar cada campo herdado como
    // opcional (spread de um tipo possivelmente `undefined`), e
    // `CodeBlockLowlightOptions` não tem campo opcional nenhum - por isso
    // cada um é lido individualmente com fallback para o default oficial da
    // lib (lido em `node_modules/@tiptap/extension-code-block-lowlight`),
    // em vez de um spread só.
    const parentOptions = this.parent?.();
    return {
      languageClassPrefix: parentOptions?.languageClassPrefix ?? "language-",
      exitOnTripleEnter: parentOptions?.exitOnTripleEnter ?? true,
      exitOnArrowDown: parentOptions?.exitOnArrowDown ?? true,
      exitOnArrowUp: parentOptions?.exitOnArrowUp ?? true,
      HTMLAttributes: parentOptions?.HTMLAttributes ?? {},
      tabSize: parentOptions?.tabSize ?? PARENT_DEFAULT_TAB_SIZE,
      lowlight: codeLowlight,
      defaultLanguage: DEFAULT_CODE_LANGUAGE,
      // Sem isso, Tab dentro do bloco cairia no keymap estrutural do core
      // (que ignora este nó - não está entre os nove tipos que ele conhece,
      // ver `node-names.ts` - e portanto não faria nada); com isso, o
      // próprio `CodeBlockLowlight` indenta o código, que é o que EDT-018
      // pede.
      enableTabIndentation: true,
    };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      // O mesmo `idAttribute` que todo `blockContent` do core carrega
      // (`schema.ts`) - não é exportado de lá, então repetido aqui.
      id: {
        default: null as string | null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.id ? { "data-block-id": attributes.id } : {},
      },
    };
  },
  addNodeView() {
    return codeBlockNodeView;
  },
});
