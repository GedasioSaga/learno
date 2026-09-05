/**
 * Nomes desta peça: o nó de bloco (equação, EDT-022) e o nó inline (EDT-023).
 * `EQUATION_BLOCK_TYPE` é o vocabulário persistido em `Block.blockType`
 * (contract.ts); `EQUATION_NODE_NAME` é o nome do nó ProseMirror. São iguais
 * aqui (nenhuma família tipo "heading_1..3"), mas ficam como duas constantes
 * porque `BlockSpec` sempre distingue os dois conceitos - ver
 * `core/block-spec.ts`.
 *
 * `INLINE_MATH_NODE_NAME` não tem `BlockSpec` correspondente: viaja dentro
 * de `content.inline` do bloco de texto que a contém, serializado pelo
 * default de `serialize.ts` (ver README, seção "A inline é uma Node
 * inline... não precisa de BlockSpec próprio").
 */
export const EQUATION_NODE_NAME = "equation";
export const EQUATION_BLOCK_TYPE = "equation";
export const INLINE_MATH_NODE_NAME = "inlineMath";
