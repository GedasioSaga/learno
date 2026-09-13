/**
 * Ponto de descoberta automática (`discover-extensions.ts`'s
 * `import.meta.glob`) desta peça: equação em bloco (EDT-022) e inline
 * (EDT-023), MathJax renderizado no cliente (EDT-083 - ver
 * `render-latex.ts`, a única porta de saída para a lib, e
 * `security.test.ts`, que prova que nada aqui chama um LaTeX externo).
 *
 * Importa sempre de `../../core/<módulo>`, nunca de `../../index` - ver
 * README sobre o ciclo de TDZ que isso evitaria.
 */
import { registerBlockSpec, registerInlinePlainText, registerSlashMenuItem, registerTurnIntoItem } from "../../core/block-spec";
import { insertBlockHere } from "../../core/commands";
import { registerBlockExtension } from "../../core/registry";
import { Equation } from "./equation-block";
import { InlineMath } from "./inline-math";
import "./math.css";
import { EQUATION_BLOCK_TYPE, EQUATION_NODE_NAME, INLINE_MATH_NODE_NAME } from "./node-names";

registerBlockExtension([Equation, InlineMath]);

registerBlockSpec({
  blockType: EQUATION_BLOCK_TYPE,
  nodeName: EQUATION_NODE_NAME,
  hasContent: false,
  serialization: {
    attrs: (_blockType, content) => ({
      expression: typeof content.expression === "string" ? content.expression : "",
    }),
    content: (attrs) => ({
      expression: typeof attrs.expression === "string" ? attrs.expression : "",
    }),
    plainText: (content) => (typeof content.expression === "string" ? content.expression : ""),
  },
});

// FUN-037: a equação inline (EDT-023) não tem BlockSpec próprio (viaja como
// JSONContent bruto dentro de content.inline - ver node-names.ts), então o
// achatador padrão de plainText não via nada dela. Contribui o LaTeX cru dos
// attrs: buscar "frac" tem que achar a nota que tem a fração, mesmo que a
// equação em bloco (acima) já contribua o mesmo texto por outro caminho.
registerInlinePlainText({
  nodeName: INLINE_MATH_NODE_NAME,
  text: (node) => (typeof node.attrs?.expression === "string" ? node.attrs.expression : ""),
});

// EDT-083: esta é a única entrada de menu que este builder registra para
// equações - client-side (MathJax) e nada mais. Nenhuma variante "LaTeX
// externo (dvipng)" existe em lugar nenhum desta pasta - ver security.test.ts.
registerSlashMenuItem({
  id: "math:equation",
  title: "Equação em bloco",
  keywords: ["equacao", "equation", "latex", "formula", "matematica", "matemática"],
  group: "Mídia",
  icon: "∑",
  run: (editor) => insertBlockHere(editor, EQUATION_NODE_NAME, { expression: "" }),
});

// EDT-049: "Transformar em" > "Equação em bloco". Mesmo motivo de
// `blocks-media:turn:image` (ver o comentário lá): `equation` é um átomo
// (`content: ""`), então `insertBlockHere` - não `turnCurrentBlockInto` - é
// quem sabe preservar o texto de um bloco não vazio em vez de rejeitá-lo.
// Sem `isActive` pelo mesmo motivo: não há posição de texto dentro de um
// átomo para o cursor confirmar "já sou este tipo".
registerTurnIntoItem({
  id: "math:turn:equation",
  title: "Equação em bloco",
  group: "Mídia",
  icon: "∑",
  run: (editor) => insertBlockHere(editor, EQUATION_NODE_NAME, { expression: "" }),
});
