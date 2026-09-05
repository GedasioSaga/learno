/**
 * EDT-044: "@" a page name, confirm it, get an inline chip that navigates to
 * that page on click - built on `@tiptap/extension-mention`, which already
 * wires the `@tiptap/suggestion` plugin (trigger detection, popup
 * positioning, keyboard nav inside the popup) through `addProseMirrorPlugins`.
 * This file only supplies the three things Mention leaves to its caller:
 * where the candidate pages come from (`items`), how the popup itself looks
 * (`render`), and how the inserted node is displayed and clicked
 * (`addNodeView`, in `mention-page-node-view.ts` - the file that also
 * explains why the display can't just be `node.attrs.label`).
 *
 * Renamed from Mention's default `"mention"` node name to `"mentionPage"` -
 * this repo has 20 other builders registering their own extensions in
 * parallel, and a persisted document should never have to guess which
 * builder's `"mention"` a stored node came from.
 */
import type { Editor, Range } from "@tiptap/core";
import { Mention } from "@tiptap/extension-mention";
import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import { PluginKey } from "@tiptap/pm/state";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { listPageTree, type PageRow } from "../../../../lib/ipc";
import { displayTitle } from "../../../pages/tree-utils";
import { mentionPageNodeView } from "./mention-page-node-view";
import { MENTION_PAGE_NODE_NAME } from "./node-name";
import "./mention-page.css";

const MENTION_PAGE_TRIGGER_CHAR = "@";
const MAX_SUGGESTIONS_SHOWN = 8;
const mentionPageSuggestionPluginKey = new PluginKey("mentionPageSuggestion");

/**
 * Prefixo dos `id` de DOM das opções do popup, referenciados por
 * `aria-activedescendant` na lista - mesma convenção de
 * `interaction/slash-menu/SlashMenuOverlay.tsx`.
 */
const OPTION_DOM_ID_PREFIX = "ed-mention-page-option-";

interface PageSuggestionItem {
  id: string;
  title: string;
}

function toSuggestionItem(page: PageRow): PageSuggestionItem {
  return { id: page.id, title: displayTitle(page) };
}

/**
 * `listPageTree()` is the Fase 1 IPC command this reuses verbatim (no new
 * Rust command) - filtering/limiting happens here because the command
 * itself always returns the whole active tree, same as `PageTree`'s own
 * sidebar filter (`searchMoveTargets` in `tree-utils.ts`) does.
 */
async function fetchPageSuggestions(query: string): Promise<PageSuggestionItem[]> {
  const pages = await listPageTree();
  const normalizedQuery = query.trim().toLowerCase();
  return pages
    .filter((page) => normalizedQuery === "" || page.title.toLowerCase().includes(normalizedQuery))
    .map(toSuggestionItem)
    .slice(0, MAX_SUGGESTIONS_SHOWN);
}

/**
 * The `/`-menu popup has no precedent yet in this repo (no other builder's
 * `register.ts` exists at the time this was written), so this follows the
 * same vanilla-DOM convention `core/node-views.ts` already set rather than
 * introducing `ReactRenderer` for one popup. `props.mount()` (not manual
 * `style.left`/`style.top`) is `@tiptap/suggestion`'s own recommended
 * positioning path - see its `SuggestionProps.mount` doc comment.
 */
function createSuggestionRender() {
  let root: HTMLDivElement | null = null;
  let list: HTMLUListElement | null = null;
  let unmount: (() => void) | null = null;
  let items: PageSuggestionItem[] = [];
  let selectedIndex = 0;
  let pick: ((item: PageSuggestionItem) => void) | null = null;

  function renderItems(): void {
    if (!list) return;
    list.replaceChildren();
    // Sem opção nenhuma realçada (lista vazia), o atributo não pode ficar
    // apontando para um `id` que acabou de sair do DOM.
    list.removeAttribute("aria-activedescendant");

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "ed-mention-page-menu__empty";
      empty.textContent = "Nenhuma página encontrada";
      list.append(empty);
      return;
    }

    items.forEach((item, index) => {
      const option = document.createElement("li");
      option.className = "ed-mention-page-menu__item";
      option.setAttribute("role", "option");
      option.id = `${OPTION_DOM_ID_PREFIX}${item.id}`;
      const isActive = index === selectedIndex;
      option.setAttribute("aria-selected", String(isActive));
      // Um `role="listbox"` navegável por teclado tem de dizer QUAL opção
      // está realçada; sem isto um leitor de tela anuncia a lista e nunca o
      // item que ArrowDown acabou de mover (`aria-selected` sozinho não
      // move o foco virtual). Mesmo contrato que o menu "/" já cumpre.
      if (isActive) {
        option.classList.add("ed-mention-page-menu__item--active");
        list?.setAttribute("aria-activedescendant", option.id);
      }
      // `textContent`, nunca `innerHTML`: `item.title` é título de página
      // digitado pelo usuário, entrada hostil como qualquer outra.
      option.textContent = item.title;
      option.addEventListener("mousedown", (event) => {
        // `mousedown` em vez de `click`: um `click` chegaria depois do
        // editor já ter perdido a seleção/o range da sugestão para o blur.
        event.preventDefault();
        pick?.(item);
      });
      list?.append(option);
    });
  }

  return {
    onStart: (props: SuggestionProps<PageSuggestionItem, MentionNodeAttrs>) => {
      items = props.items;
      selectedIndex = 0;
      pick = (item) => props.command({ id: item.id, label: item.title });

      root = document.createElement("div");
      root.className = "ed-mention-page-menu";
      list = document.createElement("ul");
      list.className = "ed-mention-page-menu__list";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "Páginas");
      root.append(list);
      renderItems();
      unmount = props.mount(root);
    },
    onUpdate: (props: SuggestionProps<PageSuggestionItem, MentionNodeAttrs>) => {
      items = props.items;
      selectedIndex = Math.min(selectedIndex, Math.max(items.length - 1, 0));
      pick = (item) => props.command({ id: item.id, label: item.title });
      renderItems();
    },
    onKeyDown: (props: SuggestionKeyDownProps) => {
      if (items.length === 0) return false;
      if (props.event.key === "ArrowDown") {
        selectedIndex = (selectedIndex + 1) % items.length;
        renderItems();
        return true;
      }
      if (props.event.key === "ArrowUp") {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        renderItems();
        return true;
      }
      if (props.event.key === "Enter") {
        const item = items[selectedIndex];
        if (item) pick?.(item);
        return true;
      }
      // Escape: devolvido como "tratado" só para impedir que o Enter
      // seguinte (se o usuário digitar mais) reabra por engano - o próprio
      // plugin de sugestão já fecha o popup sozinho ao ver `Escape`.
      return props.event.key === "Escape";
    },
    onExit: () => {
      unmount?.();
      root = null;
      list = null;
      items = [];
      pick = null;
    },
  };
}

/**
 * What confirming a suggestion (Enter or click) does to the doc - insert the
 * chip, plus a trailing space so the cursor doesn't land glued to an atom.
 * Same insertion `@tiptap/extension-mention`'s own default `command` does,
 * minus its final `window.getSelection()?.collapseToEnd()` call: a
 * Safari/IME nicety for tidying up the *native* browser selection after an
 * atom insert, which jsdom's incomplete Selection implementation throws on
 * (`InvalidStateError: There is no selection to collapse`) once
 * ProseMirror's own DOM sync hasn't produced a native range yet - surfaced
 * as an unhandled exception in `mention-page.test.ts`'s Enter/click cases.
 * Dropping it costs nothing here: this chip is an atom NodeView with no
 * text selection inside it to tidy up, so there is nothing that call would
 * have fixed for this extension specifically.
 */
function confirmMentionSuggestion({
  editor,
  range,
  props,
}: {
  editor: Editor;
  range: Range;
  props: MentionNodeAttrs;
}): void {
  // `id` só é `null` na assinatura genérica de `MentionNodeAttrs` (para
  // suportar extensões que não exigem um alvo) - a nossa sempre manda um
  // `PageSuggestionItem.id` de verdade via `pick()`, então isto nunca
  // deveria disparar; um no-op é mais seguro que inserir um chip sem alvo.
  if (props.id === null) return;
  const nodeAfter = editor.view.state.selection.$to.nodeAfter;
  const insertRange = nodeAfter?.text?.startsWith(" ") ? { from: range.from, to: range.to + 1 } : range;
  editor
    .chain()
    .focus()
    .insertContentAt(insertRange, [
      // `pageId` duplica `id` de propósito, e este é o ÚNICO lugar que
      // escreve os dois - ver `MENTION_PAGE_ID_ATTRS` sobre por que a
      // duplicação existe.
      { type: MENTION_PAGE_NODE_NAME, attrs: { id: props.id, label: props.label, pageId: props.id } },
      { type: "text", text: " " },
    ])
    .run();
}

/**
 * O attr `pageId`, além do `id` que `@tiptap/extension-mention` exige para
 * si (o `MentionNodeAttrs` do pacote é sempre `{id, label}`, e é o `id` que o
 * NodeView usa para resolver o título atual).
 *
 * Existe por causa do Postgres, não do editor: o gatilho de FUN-044
 * (`src-tauri/migrations/0016_block_page_links.sql`) descobre um link
 * procurando, em qualquer profundidade do `content` do bloco, um campo
 * chamado literalmente `pageId` - é a convenção que o bloco "link para
 * página" (`blocks/page-link`, `content.pageId`) já segue e o vocabulário
 * que `contract.ts` usa. O nó de menção viaja como JSON cru dentro do
 * `content.inline` do bloco que o contém (`marks/mention-page/register.ts`
 * explica por que não há `registerBlockSpec` aqui), então o que ele chama de
 * `id` chegava ao banco chamado `id` - e o gatilho não achava nada. Com
 * isso, TODA @-menção era invisível para os backlinks: o critério central de
 * FUN-044 ("toda @-menção gera um backlink") falhava em silêncio, sem erro
 * nenhum, porque um `INSERT ... SELECT` que não casa nada simplesmente não
 * insere.
 *
 * Renomear `id` para `pageId` não é opção (o pacote base lê `attrs.id` no
 * próprio `renderHTML` e no comando padrão), e ampliar o SQL para aceitar
 * `id` casaria também com o `attrs.id` de todo BLOCO dentro do mesmo JSON -
 * uma extração que só não erra por acaso, porque um id de bloco nunca está
 * em `pages`. Duplicar um atributo num único ponto de escrita é o menor
 * risco dos três.
 */
const MENTION_PAGE_ID_ATTRS = {
  pageId: {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute("data-page-id"),
    renderHTML: (attributes: Record<string, unknown>) =>
      typeof attributes.pageId === "string" ? { "data-page-id": attributes.pageId } : {},
  },
};

export const MentionPage = Mention.extend({
  name: MENTION_PAGE_NODE_NAME,
  addAttributes() {
    return { ...this.parent?.(), ...MENTION_PAGE_ID_ATTRS };
  },
  addOptions() {
    const base = this.parent?.();
    // `this.parent` só é `undefined` na tipagem de `.extend()` genérica -
    // `Mention` sempre declara seu próprio `addOptions`, então isto nunca
    // dispara de verdade; o `throw` existe para que o retorno abaixo não
    // precise de `as` para provar ao compilador que `base` está preenchido.
    if (!base) throw new Error("MentionPage: Mention não tem addOptions - extensão base mudou?");
    return {
      ...base,
      suggestion: {
        char: MENTION_PAGE_TRIGGER_CHAR,
        pluginKey: mentionPageSuggestionPluginKey,
        // Um título de página tem espaço - "Aula 4", "Sem título" (o título
        // padrão de toda página nova deste app). Com o default do
        // `@tiptap/suggestion` (`allowSpaces: false`, regex
        // `@[^\s@]*`), o primeiro espaço encerra a busca: digitar
        // "@Aula 4" fecha o popup em "@Aula" e deixa o resto como texto
        // solto, e nenhum chip é inserido. Custo conhecido do outro lado:
        // com espaços permitidos a query passa a ir do "@" até o fim do nó
        // de texto, então continuar escrevendo prosa depois de um "@"
        // mantém um popup de "Nenhuma página encontrada" aberto até um
        // Escape ou um clique fora. Trocamos "não dá para mencionar página
        // com espaço no nome" por "popup vazio insistente" - o segundo
        // atrapalha, o primeiro inviabiliza EDT-044 para a maioria dos
        // títulos reais.
        allowSpaces: true,
        items: ({ query }: { query: string }) => fetchPageSuggestions(query),
        render: createSuggestionRender,
        command: confirmMentionSuggestion,
      },
    };
  },
  addNodeView() {
    return mentionPageNodeView;
  },
});
