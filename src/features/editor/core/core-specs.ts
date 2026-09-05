/**
 * `BlockSpec` declarations for the nine structural types `schema.ts` owns,
 * plus their `/` menu and "Turn into" entries.
 *
 * These used to be two hardcoded string maps inside `serialize.ts`. They
 * live here now for one reason: a builder adding a tenth type registers its
 * spec exactly the way this file registers the first nine, from its own
 * folder, and `serialize.ts` reads all ten the same way. No file in `core/`
 * has a list of block types in it any more.
 *
 * Imported for its side effects by `serialize.ts` (which cannot work without
 * these) - not by `discover-extensions.ts`, so it is registered before any
 * builder's `register.ts` runs and a builder can therefore override or
 * extend a core entry deliberately.
 */
import { insertBlockHere, turnCurrentBlockInto } from "./commands";
import type { BlockSpec } from "./block-spec";
import { registerBlockSpec, registerSlashMenuItem, registerTurnIntoItem } from "./block-spec";
import { NODE_NAMES } from "./node-names";

/** The plain textual block: `content: "inline*"`, persisted as `{ inline }`. Every spec below is this plus at most one attr. */
function textualSpec(blockType: string, nodeName: string): BlockSpec {
  return { blockType, nodeName };
}

/**
 * A textual block that also persists one boolean/string attr alongside its
 * inline content (`to_do`'s `checked`, `toggle`'s `collapsed`, `callout`'s
 * `emoji`) - the attr lives in `content` so that `Block.content` alone is
 * enough to rebuild the node, with no second column per block type.
 */
function textualSpecWithAttr<T>(
  blockType: string,
  nodeName: string,
  attrName: string,
  read: (value: unknown) => T,
): BlockSpec {
  return {
    blockType,
    nodeName,
    serialization: {
      attrs: (_blockType, content) => ({ [attrName]: read(content[attrName]) }),
      content: (attrs, nodeContent) => ({ [attrName]: read(attrs[attrName]), inline: nodeContent }),
    },
  };
}

const CORE_SPECS: BlockSpec[] = [
  textualSpec("paragraph", NODE_NAMES.paragraph),
  {
    blockType: "heading",
    nodeName: NODE_NAMES.heading,
    // One spec for the whole `heading_N` family: the level is encoded in the
    // persisted type string, not in a separate content field.
    matches: (blockType) => blockType.startsWith("heading_"),
    serialization: {
      attrs: (blockType) => {
        const level = Number(blockType.slice("heading_".length));
        return { level: Number.isFinite(level) && level >= 1 && level <= 3 ? level : 1 };
      },
      blockType: (attrs) => `heading_${Number(attrs.level) || 1}`,
      content: (attrs, nodeContent) => ({ level: Number(attrs.level) || 1, inline: nodeContent }),
    },
  },
  textualSpec("bulleted_list_item", NODE_NAMES.bulletedListItem),
  textualSpec("numbered_list_item", NODE_NAMES.numberedListItem),
  textualSpecWithAttr("to_do", NODE_NAMES.todoItem, "checked", (value) => Boolean(value)),
  textualSpecWithAttr("toggle", NODE_NAMES.toggle, "collapsed", (value) => Boolean(value)),
  textualSpecWithAttr("callout", NODE_NAMES.callout, "emoji", (value) => (typeof value === "string" ? value : "💡")),
  textualSpec("quote", NODE_NAMES.quote),
  {
    blockType: "divider",
    nodeName: NODE_NAMES.divider,
    hasContent: false,
    serialization: {
      content: () => ({}),
      nodeContent: () => [],
      plainText: () => "",
    },
  },
];

registerBlockSpec(CORE_SPECS);

const BASIC = "Básico";

registerSlashMenuItem([
  {
    id: "core:paragraph",
    title: "Texto",
    keywords: ["texto", "paragrafo", "paragraph", "text"],
    group: BASIC,
    icon: "¶",
    order: 0,
    run: (editor) => turnCurrentBlockInto(editor, NODE_NAMES.paragraph),
  },
  ...[1, 2, 3].map((level) => ({
    id: `core:heading_${level}`,
    title: `Título ${level}`,
    keywords: ["titulo", "heading", `h${level}`, "cabecalho"],
    group: BASIC,
    icon: `H${level}`,
    order: level,
    run: (editor: Parameters<typeof turnCurrentBlockInto>[0]) =>
      turnCurrentBlockInto(editor, NODE_NAMES.heading, { level }),
  })),
  {
    id: "core:bulleted_list_item",
    title: "Lista com marcador",
    keywords: ["lista", "marcador", "bullet", "list"],
    group: BASIC,
    icon: "•",
    order: 4,
    run: (editor) => turnCurrentBlockInto(editor, NODE_NAMES.bulletedListItem),
  },
  {
    id: "core:numbered_list_item",
    title: "Lista numerada",
    keywords: ["lista", "numerada", "numbered", "ordered"],
    group: BASIC,
    icon: "1.",
    order: 5,
    run: (editor) => turnCurrentBlockInto(editor, NODE_NAMES.numberedListItem),
  },
  {
    id: "core:to_do",
    title: "Lista de tarefas",
    keywords: ["tarefa", "todo", "checkbox", "checklist"],
    group: BASIC,
    icon: "☑",
    order: 6,
    run: (editor) => turnCurrentBlockInto(editor, NODE_NAMES.todoItem, { checked: false }),
  },
  {
    id: "core:toggle",
    title: "Lista alternável",
    keywords: ["toggle", "alternavel", "colapsavel", "recolher"],
    group: BASIC,
    icon: "▸",
    order: 7,
    run: (editor) => turnCurrentBlockInto(editor, NODE_NAMES.toggle, { collapsed: false }),
  },
  {
    id: "core:quote",
    title: "Citação",
    keywords: ["citacao", "quote", "blockquote"],
    group: BASIC,
    icon: "❝",
    order: 8,
    run: (editor) => turnCurrentBlockInto(editor, NODE_NAMES.quote),
  },
  {
    id: "core:callout",
    title: "Destaque",
    keywords: ["destaque", "callout", "aviso", "nota"],
    group: BASIC,
    icon: "💡",
    order: 9,
    run: (editor) => turnCurrentBlockInto(editor, NODE_NAMES.callout, { emoji: "💡" }),
  },
  {
    id: "core:divider",
    title: "Divisor",
    keywords: ["divisor", "divider", "linha", "separador"],
    group: BASIC,
    icon: "—",
    order: 10,
    // A divider holds no text, so it never *converts* a block with content -
    // `insertBlockHere` puts it below instead, which is what the user means.
    run: (editor) => insertBlockHere(editor, NODE_NAMES.divider),
  },
]);

registerTurnIntoItem([
  {
    id: "core:turn:paragraph",
    title: "Texto",
    group: BASIC,
    order: 0,
    run: (editor) => turnCurrentBlockInto(editor, NODE_NAMES.paragraph),
    isActive: (editor) => editor.state.selection.$from.parent.type.name === NODE_NAMES.paragraph,
  },
  ...[1, 2, 3].map((level) => ({
    id: `core:turn:heading_${level}`,
    title: `Título ${level}`,
    group: BASIC,
    order: level,
    run: (editor: Parameters<typeof turnCurrentBlockInto>[0]) =>
      turnCurrentBlockInto(editor, NODE_NAMES.heading, { level }),
    isActive: (editor: Parameters<typeof turnCurrentBlockInto>[0]) => {
      const parent = editor.state.selection.$from.parent;
      return parent.type.name === NODE_NAMES.heading && parent.attrs.level === level;
    },
  })),
  ...(
    [
      ["bulleted_list_item", "Lista com marcador", NODE_NAMES.bulletedListItem, {}],
      ["numbered_list_item", "Lista numerada", NODE_NAMES.numberedListItem, {}],
      ["to_do", "Lista de tarefas", NODE_NAMES.todoItem, { checked: false }],
      ["toggle", "Lista alternável", NODE_NAMES.toggle, { collapsed: false }],
      ["quote", "Citação", NODE_NAMES.quote, {}],
      ["callout", "Destaque", NODE_NAMES.callout, { emoji: "💡" }],
    ] as const
  ).map(([key, title, nodeName, attrs], index) => ({
    id: `core:turn:${key}`,
    title,
    group: BASIC,
    order: 4 + index,
    run: (editor: Parameters<typeof turnCurrentBlockInto>[0]) =>
      turnCurrentBlockInto(editor, nodeName, { ...attrs }),
    isActive: (editor: Parameters<typeof turnCurrentBlockInto>[0]) =>
      editor.state.selection.$from.parent.type.name === nodeName,
  })),
]);

/** Only real work: give `serialize.ts` something to import so the registrations above are never tree-shaken away. */
export function ensureCoreSpecsRegistered(): void {
  /* side effects above */
}
