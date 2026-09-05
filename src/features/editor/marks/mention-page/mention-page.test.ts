/**
 * EDT-044. Três camadas, como o README recomenda para um builder novo:
 * a extensão está mesmo registrada (`register.ts`), o round-trip de
 * persistência não mexe em hierarquia nenhuma (`serialize.ts`, sem editor
 * real) e o chip renderizado por um `Editor` de verdade resolve o título
 * pelo id, não por uma cópia congelada (`mention-page-node-view.ts`).
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../contract";
import { listPageTree, type PageRow } from "../../../../lib/ipc";
import { usePageTreeStore } from "../../../pages/store";
import { buildEditorExtensions } from "../../core/extensions";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import { MENTION_PAGE_NODE_NAME } from "./node-name";
// Efeito colateral: registra `MentionPage` antes de `buildEditorExtensions()`
// rodar - o mesmo mecanismo que `discover-extensions.ts` usa em produção,
// só que restrito a este arquivo de teste (README: "uma pasta que ainda não
// existe" não se aplica aqui, `import.meta.glob` nem entra em cena).
import "./register";

// `fetchPageSuggestions` (mention-page.ts) chama `listPageTree()` de verdade -
// fora do Tauri esse `invoke()` rejeitaria (não há `__TAURI_INTERNALS__` no
// jsdom deste teste). Mockar só essa função, preservando o resto do módulo
// (o `PageRow` que `pageRow()` usa é tipo, mas `listPageTree` é runtime),
// é o que deixa o mecanismo de "@" de verdade (não só o node JSON cru)
// exercitável sem precisar de um banco.
vi.mock("../../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/ipc")>();
  return { ...actual, listPageTree: vi.fn() };
});

function pageRow(overrides: Partial<PageRow> & Pick<PageRow, "id" | "title">): PageRow {
  return {
    parent_id: null,
    database_id: null,
    icon: null,
    position: "a0",
    is_favorite: false,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const initialStoreState = usePageTreeStore.getState();

beforeEach(() => {
  usePageTreeStore.setState(initialStoreState, true);
});

describe("registro", () => {
  it("EDT-044: registerBlockExtension inclui o nó mentionPage na lista que o editor monta", () => {
    const names = buildEditorExtensions().map((ext) => ext.name);
    expect(names).toContain(MENTION_PAGE_NODE_NAME);
  });
});

describe("persistência (sem editor real, como serialize.test.ts)", () => {
  it("EDT-044: a menção vira parte do content.inline do bloco atual, nunca um Block novo", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            {
              type: "paragraph",
              attrs: { id: "block-1" },
              content: [
                { type: "text", text: "Ver " },
                { type: MENTION_PAGE_NODE_NAME, attrs: { id: "page-target", label: "Aula 1" } },
              ],
            },
          ],
        },
      ],
    };

    const flat = docToFlatBlocks(doc);

    // Uma menção não é um bloco: um único Block sai deste doc, não dois.
    expect(flat).toHaveLength(1);
    expect(flat[0].id).toBe("block-1");
    // FUN-043 (sub-página de verdade) mexeria em parentBlockId; a arroba-menção não.
    expect(flat[0].parentBlockId).toBeNull();
    expect(flat[0].content.inline).toEqual([
      { type: "text", text: "Ver " },
      { type: MENTION_PAGE_NODE_NAME, attrs: { id: "page-target", label: "Aula 1" } },
    ]);
  });
});

describe("chip renderizado (editor real, jsdom - mesmo padrão de commands.test.ts)", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  function createEditorWithMention(attrs: { id: string; label: string }): Editor {
    return new Editor({
      extensions: buildEditorExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "block",
            content: [
              {
                type: "paragraph",
                attrs: { id: "block-1" },
                content: [{ type: MENTION_PAGE_NODE_NAME, attrs }],
              },
            ],
          },
        ],
      },
    });
  }

  function chipEl(): HTMLElement {
    const el = editor.view.dom.querySelector<HTMLElement>(".ed-mention-page");
    if (!el) throw new Error("chip .ed-mention-page não encontrado no DOM do editor");
    return el;
  }

  // Mesmo motivo do `json()` em `commands.test.ts`: o tipo de retorno de
  // `getJSON()` estreita `.content` a ponto de não existir no ramo de texto,
  // o que só atrapalha aqui - `JSONContent` é a forma solta que este teste
  // (e `serialize.ts`) já usa para andar pela árvore.
  function json(): JSONContent {
    return editor.getJSON();
  }

  it("EDT-044: título vem do estado atual da página (usePageTreeStore), não do label congelado no attr", () => {
    usePageTreeStore.setState({
      pagesById: new Map([["page-target", pageRow({ id: "page-target", title: "Título atual" })]]),
    });
    editor = createEditorWithMention({ id: "page-target", label: "Título congelado ao inserir" });

    // `icon: null` no helper `pageRow()` cai no fallback "📄" - o mesmo que
    // `PageTreeItem`/`Breadcrumb` usam para uma página sem emoji próprio.
    expect(chipEl().textContent).toBe("📄 Título atual");
  });

  it("EDT-044: renomear a página no store (FUN-045) atualiza o chip sem tocar no doc", () => {
    usePageTreeStore.setState({
      pagesById: new Map([["page-target", pageRow({ id: "page-target", title: "Antes" })]]),
    });
    editor = createEditorWithMention({ id: "page-target", label: "Antes" });
    expect(chipEl().textContent).toBe("📄 Antes");

    // Simula o que FUN-045 faz de verdade: `usePageTreeStore.rename` troca a
    // `PageRow` no mapa. Nenhum comando do editor roda aqui.
    usePageTreeStore.setState({
      pagesById: new Map([["page-target", pageRow({ id: "page-target", title: "Depois" })]]),
    });

    expect(chipEl().textContent).toBe("📄 Depois");
    // O attr no doc nunca mudou - é exatamente por isso que o chip precisa
    // consultar o store, e não `node.attrs.label`, para mostrar "Depois".
    const mentionNode = json().content?.[0]?.content?.[0]?.content?.[0];
    expect(mentionNode?.attrs?.label).toBe("Antes");
  });

  it("EDT-044: sem página no estado atual (id desconhecido), cai para o label congelado em vez de ficar em branco", () => {
    editor = createEditorWithMention({ id: "page-sumida", label: "Título antigo" });
    // Página desconhecida (nunca esteve no store): mesmo fallback de ícone
    // de uma página sem emoji, com o label congelado em vez de "página".
    expect(chipEl().textContent).toBe("📄 Título antigo");
  });

  it("EDT-044: clicar no chip navega (troca selectedPageId) sem alterar hierarquia de páginas", () => {
    const target = pageRow({ id: "page-target", title: "Alvo", parent_id: "page-parent" });
    const other = pageRow({ id: "page-other", title: "Outra", parent_id: null });
    usePageTreeStore.setState({
      pagesById: new Map([
        ["page-target", target],
        ["page-other", other],
      ]),
    });
    editor = createEditorWithMention({ id: "page-target", label: "Alvo" });

    chipEl().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(usePageTreeStore.getState().selectedPageId).toBe("page-target");
    // Nenhuma reparentagem: o parent_id de ambas as páginas segue exatamente
    // o que era antes do clique - a distinção de EDT-044 com FUN-043.
    expect(usePageTreeStore.getState().pagesById.get("page-target")?.parent_id).toBe("page-parent");
    expect(usePageTreeStore.getState().pagesById.get("page-other")?.parent_id).toBeNull();
  });

  it("EDT-044: round trip completo - Block[] salvo (blocksToDoc) reabre com o chip ainda navegável e o content.inline idêntico ao que voltou a sair", () => {
    // O outro teste de persistência só prova doc -> FlatBlock (docToFlatBlocks).
    // Este prova a metade que faltava: FlatBlock/Block salvo -> blocksToDoc ->
    // editor reaberto de verdade, exatamente o caminho de abrir uma página.
    // Tipado à parte (não inline em `Block.content`, que é `Record<string,
    // unknown>`) só para os dois nós ficarem indexáveis nas asserções abaixo.
    const savedInline: JSONContent[] = [
      { type: "text", text: "Ver " },
      { type: MENTION_PAGE_NODE_NAME, attrs: { id: "page-target", label: "Aula 1" } },
    ];
    const savedBlock: Block = {
      id: "block-1",
      pageId: "page-1",
      parentBlockId: null,
      blockType: "paragraph",
      content: { inline: savedInline },
      plainText: "Ver ",
      syncedSourceId: null,
      position: "a0",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    usePageTreeStore.setState({
      pagesById: new Map([["page-target", pageRow({ id: "page-target", title: "Aula 1 - título atual" })]]),
    });

    editor = new Editor({ extensions: buildEditorExtensions(), content: blocksToDoc([savedBlock]) });

    expect(chipEl().textContent).toBe("📄 Aula 1 - título atual");
    chipEl().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(usePageTreeStore.getState().selectedPageId).toBe("page-target");

    // Fecha o ciclo: reserializar o doc reaberto reproduz o `content.inline`
    // salvo, mais `mentionSuggestionChar` - um attr do `Mention` base
    // (default "@") que `blocksToDoc` não escreveu, mas que todo nó
    // `mentionPage` materializado por um `Editor` real carrega de qualquer
    // forma (todo attr declarado no schema entra em `node.attrs`, escrito ou
    // não - `blocksToDoc` não precisa saber disso, só o teste que compara).
    const [flatAgain] = docToFlatBlocks(json());
    expect(flatAgain.content.inline).toEqual([
      savedInline[0],
      // `mentionSuggestionChar` é um attr do `Mention` base (default "@") e
      // `pageId` é o attr que este builder acrescenta (ver
      // `MENTION_PAGE_ID_ATTRS`); nenhum dos dois foi escrito por
      // `blocksToDoc`, mas todo attr declarado no schema entra em
      // `node.attrs` de qualquer forma - `blocksToDoc` não precisa saber
      // disso, só o teste que compara. `pageId` volta `null` aqui de
      // propósito: este bloco salvo é anterior ao attr, e uma menção antiga
      // não pode fazer o round trip explodir.
      { ...savedInline[1], attrs: { ...savedInline[1].attrs, mentionSuggestionChar: "@", pageId: null } },
    ]);
  });
});

describe("digitação real do @ (a mecânica que EDT-044 pede: gatilho -> popup -> confirmação)", () => {
  let editor: Editor;
  const listPageTreeMock = vi.mocked(listPageTree);

  beforeEach(() => {
    listPageTreeMock.mockReset();
  });

  afterEach(() => {
    editor?.destroy();
  });

  function createEmptyEditor(): Editor {
    return new Editor({
      extensions: buildEditorExtensions(),
      content: { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "block-1" } }] }] },
    });
  }

  function json(): JSONContent {
    return editor.getJSON();
  }

  /** Só o nó `mentionPage`, se o bloco tiver um - `content?.[0]` não serve mais aqui porque o comando padrão do Mention insere um espaço logo depois. */
  function insertedMentionNode(): JSONContent | undefined {
    return json().content?.[0]?.content?.[0]?.content?.find((node) => node.type === MENTION_PAGE_NODE_NAME);
  }

  it("EDT-044: digitar @ + query dispara fetchPageSuggestions (listPageTree) e o popup real lista as páginas que casam", async () => {
    listPageTreeMock.mockResolvedValue([
      pageRow({ id: "page-calc", title: "Aula de Cálculo" }),
      pageRow({ id: "page-bio", title: "Aula de Biologia" }),
    ]);
    editor = createEmptyEditor();

    // Digitar "@cálculo" de verdade - não um node JSON pronto - é o "quando"
    // que o critério EDT-044 pede e nenhum teste anterior exercitava.
    editor.commands.insertContent("@cálculo");

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".ed-mention-page-menu__item")).toHaveLength(1);
    });
    expect(listPageTreeMock).toHaveBeenCalled();
    expect(document.querySelector(".ed-mention-page-menu__item")?.textContent).toBe("Aula de Cálculo");
  });

  it("EDT-044: Enter no popup confirma a sugestão selecionada e insere o chip mentionPage (não sobra texto solto)", async () => {
    listPageTreeMock.mockResolvedValue([pageRow({ id: "page-target", title: "Página Alvo" })]);
    editor = createEmptyEditor();

    editor.commands.insertContent("@alvo");
    await vi.waitFor(() => {
      expect(document.querySelector(".ed-mention-page-menu__item")).toBeTruthy();
    });

    // Mesmo evento real que `commands.test.ts` usa para o keymap estrutural -
    // o `handleKeyDown` do plugin de sugestão escuta o mesmo `keydown` do DOM.
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(editor.view.dom.querySelector(".ed-mention-page")).toBeTruthy();
    });
    const mentionNode = insertedMentionNode();
    expect(mentionNode?.attrs?.id).toBe("page-target");
    expect(mentionNode?.attrs?.label).toBe("Página Alvo");
    // O popup fecha depois de confirmar - não fica um segundo aberto por engano.
    expect(document.querySelector(".ed-mention-page-menu")).toBeNull();
  });

  it("EDT-044: mousedown num item do popup confirma do mesmo jeito que Enter - o clique que a UI de verdade usa", async () => {
    listPageTreeMock.mockResolvedValue([pageRow({ id: "page-target", title: "Página Alvo" })]);
    editor = createEmptyEditor();

    editor.commands.insertContent("@alvo");
    await vi.waitFor(() => {
      expect(document.querySelector(".ed-mention-page-menu__item")).toBeTruthy();
    });

    const option = document.querySelector<HTMLElement>(".ed-mention-page-menu__item");
    if (!option) throw new Error("item do popup não encontrado");
    // `mousedown`, não `click` - o próprio `mention-page.ts` explica por quê
    // (o editor perderia a seleção/o range antes de um `click` chegar).
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(editor.view.dom.querySelector(".ed-mention-page")).toBeTruthy();
    });
    expect(insertedMentionNode()?.attrs?.id).toBe("page-target");
  });

  it("FUN-044: o chip inserido carrega pageId igual ao id — a chave que o gatilho de backlinks procura", async () => {
    // Regressão de produto, não de estilo: o gatilho de
    // `0016_block_page_links.sql` extrai `$.**.pageId` do `content` do
    // bloco. Sem este attr o `INSERT ... SELECT` do gatilho não casa nada,
    // não dá erro, e nenhuma @-menção nunca gera backlink. Ver
    // `MENTION_PAGE_ID_ATTRS` em `mention-page.ts` e
    // `src-tauri/tests/db_backlinks.rs`, que prova a outra metade do
    // caminho (esta forma de JSON -> linha em `block_page_links`).
    listPageTreeMock.mockResolvedValue([pageRow({ id: "page-target", title: "Página Alvo" })]);
    editor = createEmptyEditor();

    editor.commands.insertContent("@alvo");
    await vi.waitFor(() => {
      expect(document.querySelector(".ed-mention-page-menu__item")).toBeTruthy();
    });
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(editor.view.dom.querySelector(".ed-mention-page")).toBeTruthy();
    });

    expect(insertedMentionNode()?.attrs?.pageId).toBe("page-target");
    expect(insertedMentionNode()?.attrs?.pageId).toBe(insertedMentionNode()?.attrs?.id);

    // E chega até o `content` persistido: é de lá que o gatilho lê.
    const [flat] = docToFlatBlocks(json());
    const inline = flat.content.inline;
    if (!Array.isArray(inline)) throw new Error("content.inline não é um array");
    const persisted = inline.find((node) => (node as JSONContent).type === MENTION_PAGE_NODE_NAME) as
      | JSONContent
      | undefined;
    expect(persisted?.attrs?.pageId).toBe("page-target");
  });

  it("EDT-044: título com espaço ('Aula 4') é buscável — o espaço não encerra a busca do @", async () => {
    // `@tiptap/suggestion` desliga a busca no primeiro espaço por default
    // (`allowSpaces: false`), e é justamente o caso comum: quase todo título
    // real tem espaço. Sem `allowSpaces: true` o popup fecharia em "@Aula" e
    // "4" viraria texto solto.
    listPageTreeMock.mockResolvedValue([
      pageRow({ id: "page-aula-4", title: "Aula 4" }),
      pageRow({ id: "page-aula-7", title: "Aula 7" }),
    ]);
    editor = createEmptyEditor();

    editor.commands.insertContent("@Aula 4");

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".ed-mention-page-menu__item")).toHaveLength(1);
    });
    expect(document.querySelector(".ed-mention-page-menu__item")?.textContent).toBe("Aula 4");

    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(insertedMentionNode()?.attrs?.id).toBe("page-aula-4");
    });
    // Nada de "@Aula 4" sobrando em TEXTO ao lado do chip: o range da
    // sugestão cobria a query inteira, espaço incluso. Comparado nos nós
    // inline, não em `getText()` - o `renderText` do `Mention` base
    // representa o próprio chip como "@Aula 4", então o texto plano do
    // editor não distingue chip de sobra literal.
    const inlineNodes = json().content?.[0]?.content?.[0]?.content ?? [];
    expect(inlineNodes.map((node) => node.type)).toEqual([MENTION_PAGE_NODE_NAME, "text"]);
    expect(inlineNodes[1]?.text).toBe(" ");
  });

  it("EDT-044: o popup é um listbox navegável — role, aria-label e aria-activedescendant na opção realçada", async () => {
    // Contrato de acessibilidade que `e2e/specs/backlinks.e2e.mjs` também
    // usa como seletor, e o mesmo que `interaction/slash-menu` cumpre.
    listPageTreeMock.mockResolvedValue([
      pageRow({ id: "page-um", title: "Aula Um" }),
      pageRow({ id: "page-dois", title: "Aula Dois" }),
    ]);
    editor = createEmptyEditor();

    editor.commands.insertContent("@Aula");

    await vi.waitFor(() => {
      expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    });
    const list = document.querySelector('[role="listbox"]');
    expect(list?.getAttribute("aria-label")).toBe("Páginas");
    // A primeira opção nasce realçada, e é para ela que o listbox aponta.
    const [first, second] = [...document.querySelectorAll('[role="option"]')];
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("aria-selected")).toBe("false");
    expect(list?.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.id).not.toBe("");

    // ArrowDown move o realce E o `aria-activedescendant` junto - é isso que
    // um leitor de tela anuncia; `aria-selected` sozinho não move foco.
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-activedescendant")).toBe(
        document.querySelectorAll('[role="option"]')[1]?.id,
      );
    });
  });

  it("EDT-044: query sem página nenhuma casando mostra o estado vazio do popup, não uma lista sumida em silêncio", async () => {
    listPageTreeMock.mockResolvedValue([pageRow({ id: "page-existente", title: "Existe" })]);
    editor = createEmptyEditor();

    editor.commands.insertContent("@nada-bate-com-isso");

    await vi.waitFor(() => {
      expect(document.querySelector(".ed-mention-page-menu__empty")).toBeTruthy();
    });
    expect(document.querySelectorAll(".ed-mention-page-menu__item")).toHaveLength(0);
  });
});
