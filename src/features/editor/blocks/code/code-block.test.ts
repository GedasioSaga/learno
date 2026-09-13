/**
 * EDT-018: bloco de código com realce de sintaxe, seletor de linguagem
 * visível, botão de copiar e Tab que indenta o código em vez do bloco.
 *
 * Os testes de interação (`createEditor`) sobem um `Editor` real com
 * `buildEditorExtensions()` (que já inclui este bloco, registrado por
 * `./register` no import abaixo) e disparam `KeyboardEvent`s reais no DOM,
 * mesmo padrão de `core/commands.test.ts` - o Tab tem que passar pelo
 * keymap de verdade, não pela função interna chamada direto. Os testes de
 * round trip usam `blocksToDoc`/`docToFlatBlocks` puros, como
 * `core/block-spec.test.ts`.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../contract";
import { collectTurnIntoItems } from "../../core/block-spec";
import { buildEditorExtensions } from "../../core/extensions";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import "./register";
import { DEFAULT_CODE_LANGUAGE } from "./languages";

let editor: Editor;

function press(key: string, options: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

function createEditor(content: JSONContent): Editor {
  return new Editor({ extensions: buildEditorExtensions(), content });
}

function json(): JSONContent {
  return editor.getJSON();
}

function contentOf(wrapper: JSONContent): JSONContent {
  const node = wrapper.content?.[0];
  if (!node) throw new Error("wrapper sem blockContent");
  return node;
}

function startOfBlock(blockId: string): number {
  let result: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (result !== null) return false;
    if (node.attrs.id === blockId) {
      result = pos + 1;
      return false;
    }
    return true;
  });
  if (result === null) throw new Error(`bloco "${blockId}" não encontrado`);
  return result;
}

function storedBlock(overrides: Partial<Block> & Pick<Block, "id" | "blockType">): Block {
  return {
    pageId: "page-1",
    parentBlockId: null,
    content: {},
    plainText: "",
    syncedSourceId: null,
    position: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  editor?.destroy();
});

describe("realce de sintaxe", () => {
  it('EDT-018: bloco de código com linguagem "Python" colore palavra-chave, string e comentário em classes distintas', () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [
            {
              type: "codeBlock",
              attrs: { id: "c1", language: "python" },
              content: [{ type: "text", text: 'def soma(a, b):\n    # devolve a soma\n    return "resultado"' }],
            },
          ],
        },
      ],
    });

    const code = editor.view.dom.querySelector("code.ed-code-block__code");
    expect(code).not.toBeNull();
    expect(code!.querySelector(".hljs-keyword")).not.toBeNull();
    expect(code!.querySelector(".hljs-string")).not.toBeNull();
    expect(code!.querySelector(".hljs-comment")).not.toBeNull();
  });
});

describe("seletor de linguagem", () => {
  it("EDT-018: o seletor de linguagem é visível e reflete a linguagem do bloco", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [{ type: "codeBlock", attrs: { id: "c1", language: "rust" }, content: [{ type: "text", text: "fn main() {}" }] }],
        },
      ],
    });

    const select = editor.view.dom.querySelector<HTMLSelectElement>(".ed-code-block__language");
    expect(select).not.toBeNull();
    expect(select!.getAttribute("aria-label")).toBe("Linguagem do bloco de código");
    expect(select!.value).toBe("rust");
  });

  it("EDT-018: trocar a linguagem no seletor atualiza o attr do bloco", () => {
    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [{ type: "codeBlock", attrs: { id: "c1", language: "python" }, content: [{ type: "text", text: "x = 1" }] }],
        },
      ],
    });

    const select = editor.view.dom.querySelector<HTMLSelectElement>(".ed-code-block__language")!;
    select.value = "sql";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    const contentNode = contentOf(json().content![0]);
    expect(contentNode.attrs?.language).toBe("sql");
  });
});

describe("botão de copiar", () => {
  it("EDT-018: copia o texto do bloco de código para a área de transferência", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    editor = createEditor({
      type: "doc",
      content: [
        {
          type: "block",
          content: [{ type: "codeBlock", attrs: { id: "c1", language: "javascript" }, content: [{ type: "text", text: "const x = 1;" }] }],
        },
      ],
    });

    const button = editor.view.dom.querySelector<HTMLButtonElement>(".ed-code-block__copy")!;
    expect(button.getAttribute("aria-label")).toBe("Copiar código");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeText).toHaveBeenCalledWith("const x = 1;");
    expect(button.textContent).toBe("Copiado!");
  });
});

describe("Tab dentro do bloco de código", () => {
  it("EDT-018: Tab no início do bloco indenta o código, não aninha o bloco sob o irmão anterior", () => {
    editor = createEditor({
      type: "doc",
      content: [
        { type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Antes" }] }] },
        {
          type: "block",
          content: [{ type: "codeBlock", attrs: { id: "b", language: "python" }, content: [{ type: "text", text: "linha" }] }],
        },
      ],
    });

    editor.commands.setTextSelection(startOfBlock("b"));
    press("Tab");

    const doc = json();
    // Continua dois blocos de topo - se o keymap estrutural do core tivesse
    // vencido, "b" estaria aninhado como filho de "a" (README: Tab aninha o
    // bloco inteiro sob o irmão anterior) e `doc.content` teria comprimento 1.
    expect(doc.content).toHaveLength(2);
    const codeContent = contentOf(doc.content![1]);
    expect(codeContent.type).toBe("codeBlock");
    expect(codeContent.content).toEqual([{ type: "text", text: "    linha" }]);
  });
});

describe("BlockSpec: persistência", () => {
  it("EDT-018: código e linguagem sobrevivem ao round trip salvar/abrir", () => {
    const stored = storedBlock({
      id: "code-1",
      blockType: "code",
      content: { language: "rust", code: 'fn main() {\n    println!("oi");\n}' },
      plainText: 'fn main() {\n    println!("oi");\n}',
    });

    const doc = blocksToDoc([stored]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.type).toBe("codeBlock");
    expect(contentNode?.attrs).toMatchObject({ language: "rust", id: "code-1" });
    expect(contentNode?.content).toEqual([{ type: "text", text: 'fn main() {\n    println!("oi");\n}' }]);

    const [flat] = docToFlatBlocks(doc);
    expect(flat.blockType).toBe("code");
    expect(flat.content).toEqual({ language: "rust", code: 'fn main() {\n    println!("oi");\n}' });
    // O texto de busca é o código em si (pedido no enunciado), não a linguagem.
    expect(flat.plainText).toBe('fn main() {\n    println!("oi");\n}');
  });

  it("EDT-018: bloco sem code/language salvo por uma versão anterior ainda abre, com o default de linguagem", () => {
    const stored = storedBlock({ id: "code-2", blockType: "code", content: {} });

    const doc = blocksToDoc([stored]);
    const contentNode = doc.content?.[0]?.content?.[0];
    expect(contentNode?.attrs?.language).toBe(DEFAULT_CODE_LANGUAGE);
    // hasContent (default true) só escreve `content` quando o array não é
    // vazio - código vazio não deve virar `content: []` no nó.
    expect(contentNode?.content).toBeUndefined();

    const [flat] = docToFlatBlocks(doc);
    expect(flat.plainText).toBe("");
  });
});

describe('EDT-049: "Transformar em" > Código', () => {
  it("está registrado", () => {
    expect(collectTurnIntoItems().find((i) => i.id === "blocks:turn:code")).toMatchObject({ title: "Código" });
  });

  it("transforma um parágrafo com texto em bloco de código - o documento resultante tem o nó certo e o texto sobrevive", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "const x = 1" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a") + 1);
    const item = collectTurnIntoItems().find((i) => i.id === "blocks:turn:code");
    if (!item) throw new Error('item "blocks:turn:code" não registrado');

    expect(item.run(editor)).toBe(true);

    const node = contentOf(json().content![0]);
    expect(node.type).toBe("codeBlock");
    expect(node.attrs?.language).toBe(DEFAULT_CODE_LANGUAGE);
    expect(node.content).toEqual([{ type: "text", text: "const x = 1" }]);
  });

  it("transforma de volta para texto sem perder o id do bloco", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "codeBlock", attrs: { id: "a", language: "js" }, content: [{ type: "text", text: "1 + 1" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("a"));
    const paragraphItem = collectTurnIntoItems().find((i) => i.id === "core:turn:paragraph");
    if (!paragraphItem) throw new Error('item "core:turn:paragraph" não registrado');

    expect(paragraphItem.run(editor)).toBe(true);

    const node = contentOf(json().content![0]);
    expect(node.type).toBe("paragraph");
    expect(node.attrs?.id).toBe("a");
    expect(node.content).toEqual([{ type: "text", text: "1 + 1" }]);
  });
});
