/**
 * Nomes e constantes desta peça (EDT-033: colunas / layout multi-coluna).
 *
 * Dois tipos de nó, não um: `columnList` é o container (nenhum texto, nenhum
 * atributo além do `id`) e `column` é uma coluna individual (guarda a
 * fração de largura). Ambos são "vazios" do ponto de vista do próprio
 * ProseMirror (`content: ""` em `column-nodes.ts`) - o que cada um
 * efetivamente contém (as colunas dentro de `columnList`, os blocos dentro
 * de `column`) mora no `childBlocks` do `Block` wrapper que os envolve, o
 * mesmo mecanismo genérico que `toggle` já usa para seus filhos (ver
 * `core/schema.ts` e o README). Essa é a decisão central desta peça: dois
 * `blockType` de verdade, cada coluna e cada bloco dentro dela com sua
 * própria linha em `blocks` (parentBlockId encadeado), em vez de uma árvore
 * inteira serializada dentro de um `content` JSONB só - a alternativa (a)
 * que o enunciado descreve. `docToFlatBlocks` (core/serialize.ts) já sabe
 * descer em `childBlocks` recursivamente, então essa árvore de dois níveis
 * (columnList -> column -> bloco) round-tripa sem tocar em `core/` - ver
 * `column-commands.test.ts`.
 */
export const COLUMN_LIST_NODE_NAME = "columnList";
export const COLUMN_LIST_BLOCK_TYPE = "column_list";
export const COLUMN_NODE_NAME = "column";
export const COLUMN_BLOCK_TYPE = "column";

/** Largura inicial de cada coluna quando um layout de duas colunas é criado. */
export const DEFAULT_COLUMN_WIDTH = 0.5;

/** Nenhuma coluna pode encolher a ponto de desaparecer visualmente. */
export const COLUMN_MIN_WIDTH = 0.15;

/** Fração transferida por pressão de seta ou por "clique" no redimensionamento por teclado. */
export const COLUMN_RESIZE_STEP = 0.05;
