/**
 * Testa os quatro blocos de mídia (EDT-024/025/026/027) e colar imagem
 * (EDT-061) contra um `Editor` de verdade - as mesmas extensões que
 * `Editor.tsx` monta (`buildEditorExtensions`) - e contra o par
 * `blocksToDoc`/`docToFlatBlocks` que decide o que sobrevive ao salvar.
 * `import "./register"` no topo é o que faz este arquivo (e só ele, dado o
 * isolamento por arquivo do vitest) enxergar os quatro tipos e o item do
 * menu "/" - sem ele o registro global continuaria vazio.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Slice } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../contract";
import { collectSlashMenuItems, collectTurnIntoItems } from "../../core/block-spec";
import { buildEditorExtensions } from "../../core/extensions";
import { blocksToDoc, docToFlatBlocks } from "../../core/serialize";
import { clampImageWidth, IMAGE_MAX_WIDTH_PERCENT, IMAGE_MIN_WIDTH_PERCENT } from "./media-nodes";
import "./register";
import { fillMediaNode, IMAGE_KIND, insertMediaFromFile, VIDEO_KIND } from "./media-upload";

let editor: Editor;

function createEditor(content?: JSONContent): Editor {
  return new Editor({
    extensions: buildEditorExtensions(),
    content: content ?? {
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }],
    },
  });
}

/** Início do texto do bloco `blockId`, achado andando pelo doc - mesmo padrão de `core/commands.test.ts`. */
function startOfBlock(blockId: string): number {
  let result: number | null = null;
  editor.state.doc.descendants((node: PMNode, pos: number) => {
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

function firstNodeOfType(typeName: string): { pos: number; node: PMNode } | null {
  let result: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (result !== null) return false;
    if (node.type.name === typeName) {
      result = { pos, node };
      return false;
    }
    return true;
  });
  return result;
}

function slashItem(id: string) {
  const item = collectSlashMenuItems().find((entry) => entry.id === id);
  if (!item) throw new Error(`item de menu "${id}" não registrado`);
  return item;
}

function turnIntoItem(id: string) {
  const item = collectTurnIntoItems().find((entry) => entry.id === id);
  if (!item) throw new Error(`item de "Transformar em" "${id}" não registrado`);
  return item;
}

afterEach(() => {
  editor?.destroy();
});

describe("Menu \"/\": os quatro tipos nascem vazios, prontos para upload/URL/colar", () => {
  it("EDT-024: \"Imagem\" converte o bloco vazio num bloco de imagem sem arquivo, largura 100%", () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));
    expect(slashItem("blocks-media:image").run(editor)).toBe(true);

    const found = firstNodeOfType("image");
    expect(found).not.toBeNull();
    expect(found?.node.attrs.src).toBe("");
    expect(found?.node.attrs.width).toBe(100);
  });

  it("EDT-025: \"Vídeo\" converte o bloco vazio num bloco de vídeo sem arquivo", () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));
    expect(slashItem("blocks-media:video").run(editor)).toBe(true);
    expect(firstNodeOfType("video")).not.toBeNull();
  });

  it("EDT-026: \"Áudio\" converte o bloco vazio num bloco de áudio sem arquivo", () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));
    expect(slashItem("blocks-media:audio").run(editor)).toBe(true);
    expect(firstNodeOfType("audio")).not.toBeNull();
  });

  it("EDT-027: \"Arquivo anexado\" converte o bloco vazio num bloco de arquivo sem arquivo", () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));
    expect(slashItem("blocks-media:file").run(editor)).toBe(true);
    expect(firstNodeOfType("file")).not.toBeNull();
  });
});

describe("BlockSpec: os quatro tipos sobrevivem ao round trip content -> doc -> content", () => {
  function baseBlock(overrides: Partial<Block> & Pick<Block, "id" | "blockType" | "content">): Block {
    return {
      pageId: "page-1",
      parentBlockId: null,
      plainText: "",
      syncedSourceId: null,
      position: "a0",
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      ...overrides,
    };
  }

  function roundTrip(block: Block) {
    const doc = blocksToDoc([block]);
    return docToFlatBlocks(doc)[0];
  }

  it("EDT-024: imagem preserva src, legenda e largura - redimensionar e perder ao reabrir não cumpre o critério", () => {
    const flat = roundTrip(
      baseBlock({
        id: "img-1",
        blockType: "image",
        content: { src: "abc123.png", fileName: "foto.png", mimeType: "image/png", size: 2048, caption: "Minha foto", width: 42 },
      }),
    );
    expect(flat.blockType).toBe("image");
    expect(flat.content).toMatchObject({ src: "abc123.png", caption: "Minha foto", width: 42 });
    expect(flat.plainText).toBe("Minha foto");
  });

  it("EDT-025: vídeo preserva src e nome do arquivo", () => {
    const flat = roundTrip(
      baseBlock({
        id: "vid-1",
        blockType: "video",
        content: { src: "v1.mp4", fileName: "aula.mp4", mimeType: "video/mp4", size: 999 },
      }),
    );
    expect(flat.blockType).toBe("video");
    expect(flat.content).toMatchObject({ src: "v1.mp4", fileName: "aula.mp4" });
    expect(flat.plainText).toBe("aula.mp4");
  });

  it("EDT-026: áudio preserva src e nome do arquivo", () => {
    const flat = roundTrip(
      baseBlock({
        id: "aud-1",
        blockType: "audio",
        content: { src: "a1.mp3", fileName: "podcast.mp3", mimeType: "audio/mpeg", size: 555 },
      }),
    );
    expect(flat.blockType).toBe("audio");
    expect(flat.content).toMatchObject({ src: "a1.mp3", fileName: "podcast.mp3" });
  });

  it("EDT-027: arquivo anexado preserva src/nome/tipo/tamanho e usa o nome como texto buscável", () => {
    const flat = roundTrip(
      baseBlock({
        id: "file-1",
        blockType: "file",
        content: { src: "f1.pdf", fileName: "contrato.pdf", mimeType: "application/pdf", size: 12345 },
      }),
    );
    expect(flat.blockType).toBe("file");
    expect(flat.content).toMatchObject({ src: "f1.pdf", fileName: "contrato.pdf", mimeType: "application/pdf", size: 12345 });
    expect(flat.plainText).toBe("contrato.pdf");
  });

  it("regra 5, caso obrigatório: content sem nenhum campo opcional (só src) não quebra - width/caption/fileName caem no default, não em undefined solto", () => {
    const flat = roundTrip(baseBlock({ id: "img-2", blockType: "image", content: { src: "so-o-src.png" } }));
    expect(flat.blockType).toBe("image");
    expect(flat.content).toEqual({
      src: "so-o-src.png",
      fileName: "",
      mimeType: "",
      size: 0,
      caption: "",
      width: 100,
    });
    expect(flat.plainText).toBe("");
  });
});

describe("EDT-024: redimensionar pela borda persiste em content.width", () => {
  it(`clampImageWidth mantém o valor entre ${IMAGE_MIN_WIDTH_PERCENT} e ${IMAGE_MAX_WIDTH_PERCENT}`, () => {
    expect(clampImageWidth(5)).toBe(IMAGE_MIN_WIDTH_PERCENT);
    expect(clampImageWidth(500)).toBe(IMAGE_MAX_WIDTH_PERCENT);
    expect(clampImageWidth(55.6)).toBe(56);
  });

  it("gravar `width` no nó (o que o fim do arrasto faz) sobrevive ao round trip pelo BlockSpec", () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));
    slashItem("blocks-media:image").run(editor);
    const before = firstNodeOfType("image");
    if (!before) throw new Error("bloco de imagem não encontrado");

    editor.view.dispatch(editor.state.tr.setNodeAttribute(before.pos, "width", 37));

    const after = firstNodeOfType("image");
    expect(after?.node.attrs.width).toBe(37);

    const [flat] = docToFlatBlocks(editor.getJSON());
    expect(flat.blockType).toBe("image");
    expect(flat.content.width).toBe(37);
  });
});

describe("EDT-061: colar uma imagem do clipboard num bloco vazio", () => {
  function pastePlugin() {
    const plugin = editor.state.plugins.find((candidate) => typeof candidate.props.handlePaste === "function");
    if (!plugin) throw new Error("plugin de colar (EDT-061) não encontrado entre os plugins do editor");
    return plugin;
  }

  // jsdom não implementa `ClipboardEvent`/`DataTransfer` (confirmado: ambos
  // são `undefined` no ambiente de teste) - este dublê só carrega os dois
  // campos que `handlePaste` de fato lê (`clipboardData.files` e
  // `preventDefault`), então o teste exercita o comportamento real do
  // plugin sem precisar de uma API que o ambiente de teste não tem.
  function fakePasteEvent(files: File[]): ClipboardEvent {
    return { clipboardData: { files }, preventDefault: () => {} } as unknown as ClipboardEvent;
  }

  it("nasce como bloco de imagem sem etapa manual de upload", async () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));
    const file = new File(["fake-png-bytes"], "print.png", { type: "image/png" });

    const handled = pastePlugin().props.handlePaste?.call(pastePlugin(), editor.view, fakePasteEvent([file]), Slice.empty);
    expect(handled).toBe(true);

    // A gravação (`storeMediaFile`) é assíncrona - dá tempo do microtask que
    // `finalizeUpload` dispara terminar antes de checar o resultado.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const found = firstNodeOfType("image");
    expect(found).not.toBeNull();
    expect(found?.node.attrs.fileName).toBe("print.png");
    expect(found?.node.attrs.loading).toBe(false);
    expect(found?.node.attrs.uploadToken).toBeNull();
    expect(String(found?.node.attrs.src)).not.toBe("");
  });

  it("não intercepta quando o bloco sob o cursor já tem texto", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Olá" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("p1") + 3);
    const file = new File(["fake-png-bytes"], "print.png", { type: "image/png" });

    const handled = pastePlugin().props.handlePaste?.call(pastePlugin(), editor.view, fakePasteEvent([file]), Slice.empty);
    expect(handled).toBe(false);
    expect(firstNodeOfType("image")).toBeNull();
  });

  it("ignora colar sem nenhum arquivo de imagem no clipboard", () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));

    const handled = pastePlugin().props.handlePaste?.call(pastePlugin(), editor.view, fakePasteEvent([]), Slice.empty);
    expect(handled).toBe(false);
  });
});

describe("Validação de arquivo (EDT-024/025/026/027): tipo MIME e teto de tamanho barram o upload", () => {
  it("insertMediaFromFile não insere nada quando o arquivo não passa na validação", async () => {
    editor = createEditor();
    const before = editor.getJSON();
    const badFile = new File(["conteudo"], "virus.exe", { type: "application/x-msdownload" });

    const inserted = await insertMediaFromFile(editor, IMAGE_KIND, badFile);

    expect(inserted).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it("fillMediaNode marca `error` no próprio nó quando o arquivo escolhido não bate com o tipo do bloco", async () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));
    slashItem("blocks-media:video").run(editor);
    const before = firstNodeOfType("video");
    if (!before) throw new Error("bloco de vídeo não encontrado");

    const wrongFile = new File(["não é vídeo"], "foto.png", { type: "image/png" });
    await fillMediaNode(editor, before.pos, VIDEO_KIND, wrongFile);

    const after = firstNodeOfType("video");
    expect(after?.node.attrs.error).toBeTruthy();
    expect(after?.node.attrs.loading).toBe(false);
  });

  it("fillMediaNode preenche `src`/`fileName` no nó existente quando o arquivo é válido (botão \"Enviar arquivo\" do NodeView)", async () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));
    slashItem("blocks-media:video").run(editor);
    const before = firstNodeOfType("video");
    if (!before) throw new Error("bloco de vídeo não encontrado");
    expect(before.node.attrs.src).toBe("");

    const goodFile = new File(["bytes de vídeo"], "aula.mp4", { type: "video/mp4" });
    await fillMediaNode(editor, before.pos, VIDEO_KIND, goodFile);

    const after = firstNodeOfType("video");
    expect(after?.node.attrs.error).toBeNull();
    expect(after?.node.attrs.loading).toBe(false);
    expect(after?.node.attrs.uploadToken).toBeNull();
    expect(after?.node.attrs.fileName).toBe("aula.mp4");
    expect(String(after?.node.attrs.src)).not.toBe("");
  });
});

describe('"Transformar em" > Imagem', () => {
  it("num bloco vazio, converte no lugar - o documento resultante tem o nó image", () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock("p1"));

    expect(turnIntoItem("blocks-media:turn:image").run(editor)).toBe(true);

    expect(firstNodeOfType("image")).not.toBeNull();
    // Converteu no lugar - não sobrou um segundo bloco.
    expect(editor.getJSON().content).toHaveLength(1);
  });

  it("num bloco com texto, o texto sobrevive (a imagem entra como próximo irmão, não substitui)", () => {
    editor = createEditor({
      type: "doc",
      content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Legenda" }] }] }],
    });
    editor.commands.setTextSelection(startOfBlock("p1") + 1);

    expect(turnIntoItem("blocks-media:turn:image").run(editor)).toBe(true);

    const doc = editor.getJSON();
    expect(doc.content).toHaveLength(2);
    expect(doc.content?.[0]?.content?.[0]).toMatchObject({ type: "paragraph", content: [{ text: "Legenda" }] });
    expect(firstNodeOfType("image")).not.toBeNull();
  });
});
