/**
 * The nine textual block types this builder owns (EDT-001/002/003/004/006/
 * 007/009/010/012/013/016 - heading has 3 levels under one node type).
 *
 * Every one of them is a `"blockContent"`-group node with plain `"inline*"`
 * content (`""` for divider, which has none) - never anything else, and
 * never its own nested children directly. ProseMirror schemas reject mixing
 * inline and block content in one node's content expression outright
 * ("Mixing inline and block content" - `commands.test.ts` caught this the
 * first time this file tried `"inline* childBlocks?"` on these directly), so
 * a block's text and its nested children can never live in the same node.
 * The generic `Block` wrapper below is what actually holds both, as two
 * separate children - see its own doc comment, and the README for why every
 * block getting the same wrapper (not just toggle, not just lists) is the
 * decision that makes Tab/Shift-Tab (EDT-067/068) and toggle's children
 * (EDT-010) one implementation instead of several.
 *
 * None of these render list markers, checkmarks or a collapse arrow via a
 * NodeView unless the marker needs to be *interactive* (todoItem's checkbox,
 * toggle's arrow - see `node-views.ts`). Bullets, numbers (EDT-008's
 * renumbering included) and the quote bar are pure CSS on the block's own
 * `data-*` attributes - no JS bookkeeping to keep in sync.
 */
import { InputRule, Node, mergeAttributes } from "@tiptap/core";
import type { NodeType } from "@tiptap/pm/model";
import { NODE_NAMES } from "./node-names";
import { todoItemNodeView, toggleNodeView } from "./node-views";

/**
 * O atalho markdown de um tipo estrutural: apaga o marcador digitado e
 * **relabela o bloco atual**, preservando o `id` que ele já tem.
 *
 * Existe porque nenhum dos dois helpers prontos do TipTap serve aqui, e usar
 * o errado falha de dois jeitos que `input-rules.test.ts` pegou:
 *
 * - `nodeInputRule` *insere um nó*, o que é certo para um átomo e errado para
 *   uma conversão de bloco de texto: `- ` não convertia nada (inserir um nó
 *   do grupo `blockContent` numa posição inline é inválido) e `1. `/`[] `/
 *   `> ` convertiam mas **perdiam o texto digitado depois do marcador**.
 * - `textblockTypeInputRule` converte certo, mas chama `setBlockType` com só
 *   os attrs informados, e o `id` do bloco cai para o default `null` — aí
 *   `unique-ids.ts` gera um id novo. Um id novo a cada atalho digitado faz o
 *   autosave apagar a linha antiga e criar outra (ver
 *   `use-blocks-document.ts`), o que é o oposto de "o mesmo bloco relabelado".
 *
 * O outro erro que isto conserta é mais sutil: `getAttributes: { id:
 * newBlockId() }` é um objeto literal, avaliado **uma vez** quando
 * `addInputRules()` roda — todo bloco criado por aquele atalho nascia com o
 * mesmo id. Aqui o id nunca é gerado: é o do bloco que já está sob o cursor.
 */
function blockShortcutRule(config: {
  find: RegExp;
  /** Lido na hora do match, não no registro: `this.type` não existe ainda quando `addInputRules()` roda. */
  type: () => NodeType;
  attrs?: Record<string, unknown>;
}) {
  return new InputRule({
    find: config.find,
    handler: ({ state, range }) => {
      const $from = state.doc.resolve(range.from);
      const contentNode = $from.parent;
      const contentPos = $from.before($from.depth);
      // A ordem importa: apagar o marcador primeiro deixa o bloco vazio, que
      // é o único estado em que converter para um átomo (divider) é legal. O
      // `delete` só toca posições >= `range.from`, e `contentPos` é anterior,
      // então ele continua válido depois.
      state.tr.delete(range.from, range.to);
      state.tr.setNodeMarkup(contentPos, config.type(), {
        ...(config.attrs ?? {}),
        id: contentNode.attrs.id,
      });
    },
  });
}

/** Every `blockContent` node's `id` attribute - reflected to `data-block-id` so a NodeView or CSS rule can address the DOM node by it. */
const idAttribute = {
  id: {
    default: null as string | null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.id ? { "data-block-id": attributes.id } : {},
  },
};

export const Paragraph = Node.create({
  name: NODE_NAMES.paragraph,
  group: "blockContent",
  content: "inline*",
  addAttributes() {
    return idAttribute;
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${NODE_NAMES.paragraph}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-block-type": NODE_NAMES.paragraph, class: "ed-block ed-paragraph" }),
      0,
    ];
  },
});

export const Heading = Node.create({
  name: NODE_NAMES.heading,
  group: "blockContent",
  content: "inline*",
  addAttributes() {
    return { ...idAttribute, level: { default: 1 } };
  },
  parseHTML() {
    return [1, 2, 3].map((level) => ({
      tag: `div[data-block-type="${NODE_NAMES.heading}"][data-level="${level}"]`,
      attrs: { level },
    }));
  },
  renderHTML({ node, HTMLAttributes }) {
    const level = node.attrs.level;
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": NODE_NAMES.heading,
        "data-level": level,
        class: `ed-block ed-heading ed-heading--${level}`,
        role: "heading",
        "aria-level": level,
      }),
      0,
    ];
  },
  addInputRules() {
    return [1, 2, 3].map((level) =>
      blockShortcutRule({
        find: new RegExp(`^#{${level}}\\s$`),
        type: () => this.type,
        attrs: { level },
      }),
    );
  },
});

export const BulletedListItem = Node.create({
  name: NODE_NAMES.bulletedListItem,
  group: "blockContent",
  content: "inline*",
  addAttributes() {
    return idAttribute;
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${NODE_NAMES.bulletedListItem}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": NODE_NAMES.bulletedListItem,
        class: "ed-block ed-list-item ed-list-item--bulleted",
        role: "listitem",
      }),
      0,
    ];
  },
  addInputRules() {
    return [
      blockShortcutRule({
        find: /^\s*[-*+]\s$/,
        type: () => this.type,
      }),
    ];
  },
});

export const NumberedListItem = Node.create({
  name: NODE_NAMES.numberedListItem,
  group: "blockContent",
  content: "inline*",
  addAttributes() {
    return idAttribute;
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${NODE_NAMES.numberedListItem}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": NODE_NAMES.numberedListItem,
        class: "ed-block ed-list-item ed-list-item--numbered",
        role: "listitem",
      }),
      0,
    ];
  },
  addInputRules() {
    return [
      // EDT-007: "1. " starts a numbered list at 1. EDT-008's renumbering
      // (item 2 removed -> old item 3 shows "2") is pure CSS (see
      // `editor.css`'s `counter-reset`/`counter-increment` on consecutive
      // `ed-list-item--numbered` siblings) - no number is ever stored.
      blockShortcutRule({
        find: /^1\.\s$/,
        type: () => this.type,
      }),
    ];
  },
});

export const TodoItem = Node.create({
  name: NODE_NAMES.todoItem,
  group: "blockContent",
  content: "inline*",
  addAttributes() {
    return { ...idAttribute, checked: { default: false } };
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${NODE_NAMES.todoItem}"]` }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": NODE_NAMES.todoItem,
        "data-checked": String(Boolean(node.attrs.checked)),
        class: "ed-block ed-todo",
        role: "listitem",
      }),
      0,
    ];
  },
  addInputRules() {
    return [
      blockShortcutRule({
        find: /^\[\s?\]\s$/,
        type: () => this.type,
        attrs: { checked: false },
      }),
    ];
  },
  addNodeView() {
    return todoItemNodeView;
  },
});

export const Toggle = Node.create({
  name: NODE_NAMES.toggle,
  group: "blockContent",
  content: "inline*",
  addAttributes() {
    return { ...idAttribute, collapsed: { default: false } };
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${NODE_NAMES.toggle}"]` }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": NODE_NAMES.toggle,
        "data-collapsed": String(Boolean(node.attrs.collapsed)),
        class: "ed-block ed-toggle",
      }),
      0,
    ];
  },
  addInputRules() {
    return [
      blockShortcutRule({
        find: /^>\s$/,
        type: () => this.type,
        attrs: { collapsed: false },
      }),
    ];
  },
  addNodeView() {
    return toggleNodeView;
  },
});

export const Quote = Node.create({
  name: NODE_NAMES.quote,
  group: "blockContent",
  content: "inline*",
  addAttributes() {
    return idAttribute;
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${NODE_NAMES.quote}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-block-type": NODE_NAMES.quote, class: "ed-block ed-quote" }),
      0,
    ];
  },
  addInputRules() {
    return [
      // EDT-012: a straight double quote + space, not the smart-quote glyph.
      blockShortcutRule({
        find: /^"\s$/,
        type: () => this.type,
      }),
    ];
  },
});

export const Callout = Node.create({
  name: NODE_NAMES.callout,
  group: "blockContent",
  content: "inline*",
  addAttributes() {
    return { ...idAttribute, emoji: { default: "💡" } };
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${NODE_NAMES.callout}"]` }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": NODE_NAMES.callout,
        "data-emoji": node.attrs.emoji,
        class: "ed-block ed-callout",
      }),
      0,
    ];
  },
  // EDT-013 is created from the "/" menu (interaction/ builder's territory),
  // not typed inline, so no input rule here - only the node type itself.
});

export const Divider = Node.create({
  name: NODE_NAMES.divider,
  group: "blockContent",
  content: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return idAttribute;
  },
  parseHTML() {
    return [{ tag: `div[data-block-type="${NODE_NAMES.divider}"]` }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-block-type": NODE_NAMES.divider,
        class: "ed-block ed-divider",
        contenteditable: "false",
        "aria-hidden": "true",
      }),
    ];
  },
  addInputRules() {
    return [
      blockShortcutRule({
        find: /^---$/,
        type: () => this.type,
      }),
    ];
  },
});

/**
 * The generic wrapper every block actually is, one level above its
 * `blockContent` node: `content: "blockContent childBlocks?"`. Carries no
 * `id`/`blockType` of its own - those live on the `blockContent` child (see
 * `serialize.ts`, which unwraps/rewraps this on every load and save). Plain
 * `renderHTML`/`0` hole is enough (no NodeView needed): ProseMirror puts the
 * `blockContent` node's own `<div>` and, when present, `childBlocks`' `<div>`
 * as ordinary sibling DOM nodes inside this wrapper's `<div>` - ordinary
 * nested `<div>`s, so no HTML-nesting legality problem despite one block
 * type's content sitting "inside" another's markup.
 */
export const Block = Node.create({
  name: NODE_NAMES.block,
  group: "block",
  content: "blockContent childBlocks?",
  parseHTML() {
    return [{ tag: "div.ed-block-wrapper" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "ed-block-wrapper" }), 0];
  },
});

/**
 * Structural wrapper, never a `Block` row (see `node-names.ts`). Deliberately
 * outside the "block" group and `isolating: true` so plain ProseMirror
 * editing (selection, gap cursor, drag) treats its boundary as a wall - the
 * custom commands in `commands.ts` are what cross it on purpose.
 */
export const ChildBlocks = Node.create({
  name: NODE_NAMES.childBlocks,
  content: "block+",
  selectable: false,
  isolating: true,
  parseHTML() {
    return [{ tag: "div.ed-children" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "ed-children" }), 0];
  },
});

/** Replaces StarterKit's `document` (disabled in `Editor.tsx`) - a flat `block+` root (of `Block` wrappers) instead of one hardcoded to StarterKit's own node set. */
export const EditorDocument = Node.create({
  name: NODE_NAMES.doc,
  topNode: true,
  content: "block+",
});

export const structuralNodes = [
  EditorDocument,
  Block,
  Paragraph,
  Heading,
  BulletedListItem,
  NumberedListItem,
  TodoItem,
  Toggle,
  Quote,
  Callout,
  Divider,
  ChildBlocks,
];
