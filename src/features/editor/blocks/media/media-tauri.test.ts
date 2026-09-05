/**
 * O ramo `isTauri()===true` de `storeMediaFile`/`resolveMediaSrc` e o que
 * `fillMediaNode`/`insertMediaFromFile` fazem quando ele falha - a lacuna
 * apontada pelo critic: `media-storage.test.ts` e `media-blocks.test.ts`
 * só exercitam `isTauri()===false` (o modo `vitest`/`vite dev` num
 * browser comum), então o caminho que roda na app real ficava invisível
 * para qualquer teste.
 *
 * Só as bordas de plataforma são mockadas (`@tauri-apps/plugin-fs`,
 * `@tauri-apps/api/core`, `@tauri-apps/api/path`, `lib/ipc`) - o resto
 * (`storeMediaFile`, `resolveMediaSrc`, `fillMediaNode`,
 * `insertMediaFromFile`) roda de verdade. Isso prova que a lógica do ramo
 * Tauri está correta quando o plugin responde (grava, dedumplica, resolve
 * de volta) E que ela não deixa o bloco preso em "Enviando…" nem some com
 * o erro quando o plugin rejeita - mas não prova, e não tenta provar, que
 * o plugin de fato responde na app empacotada: isso depende de uma
 * capability ("fs:...") que agora existe em
 * `src-tauri/capabilities/default.json` (`fs:allow-exists`,
 * `fs:allow-mkdir`, `fs:allow-write-file`, escopados a `$APPDATA/media`),
 * e de `assetProtocol`/CSP em `src-tauri/tauri.conf.json` - vitest não roda
 * dentro de um WebView real, então não observa nem a ACL nem o `img-src`/
 * `media-src` do CSP sendo de fato respeitados. A prova real desses dois é
 * `cargo build` regenerando `gen/schemas/` sem erro de validação (um
 * identificador ou escopo mal escrito falha o build) - ver o relatório
 * desta rodada para o comando exato e o resultado.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = {
  exists: vi.fn<(path: string) => Promise<boolean>>(),
  mkdir: vi.fn<(path: string) => Promise<void>>(),
  writeFile: vi.fn<(path: string, data: Uint8Array) => Promise<void>>(),
};

vi.mock("@tauri-apps/plugin-fs", () => fsMock);
// `isTauri()===true` sempre neste arquivo - é exatamente o ramo que os
// outros testes da pasta não alcançam.
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));
// Mesmo diretório de `media-storage.ts` (ambos em blocks/media/), então o
// specifier relativo resolve para o mesmo módulo dos dois lados.
vi.mock("../../../../lib/ipc", () => ({
  getDataDir: async () => null,
}));

const { storeMediaFile, resolveMediaSrc } = await import("./media-storage");
const { fillMediaNode, insertMediaFromFile, AUDIO_KIND, VIDEO_KIND } = await import("./media-upload");
const { buildEditorExtensions } = await import("../../core/extensions");
const { collectSlashMenuItems } = await import("../../core/block-spec");
const { Editor: RealEditor } = await import("@tiptap/core");
await import("./register");

function makeFile(name: string, type: string, content = "conteúdo"): File {
  return new File([content], name, { type });
}

beforeEach(() => {
  fsMock.exists.mockReset().mockResolvedValue(false);
  fsMock.mkdir.mockReset().mockResolvedValue(undefined);
  fsMock.writeFile.mockReset().mockResolvedValue(undefined);
});

describe("storeMediaFile dentro do Tauri (plugin-fs mockado)", () => {
  it("cria a subpasta media/ (ainda não existe) e grava o arquivo com nome = hash do conteúdo + extensão original", async () => {
    const file = makeFile("foto.png", "image/png", "bytes-fixos");
    const stored = await storeMediaFile(file);

    expect(fsMock.mkdir).toHaveBeenCalledTimes(1);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    expect(stored.src).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(stored.url).toBe(`asset://localhost/app-data/media/${stored.src}`);
  });

  it("dois arquivos com o mesmo conteúdo dedumplicam: mesma chave persistida, uma só gravação em disco", async () => {
    const fileA = makeFile("a.png", "image/png", "mesmo-conteudo");
    const fileB = makeFile("b.png", "image/png", "mesmo-conteudo");

    const first = await storeMediaFile(fileA);
    // A partir daqui a pasta e o arquivo já existem - o segundo `store`
    // não deve regravar.
    fsMock.exists.mockResolvedValue(true);
    const second = await storeMediaFile(fileB);

    expect(first.src).toBe(second.src);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
  });

  it("resolveMediaSrc reconstrói a mesma URL asset:// a partir do nome persistido em content.src", async () => {
    expect(await resolveMediaSrc("abc123.mp4")).toBe("asset://localhost/app-data/media/abc123.mp4");
  });
});

describe("fillMediaNode/insertMediaFromFile quando o plugin-fs rejeita (reproduz o defeito real: ACL sem fs:*)", () => {
  function createEditor(): Editor {
    return new RealEditor({
      extensions: buildEditorExtensions(),
      content: { type: "doc", content: [{ type: "block", content: [{ type: "paragraph", attrs: { id: "p1" } }] }] },
    });
  }

  function startOfBlock(editor: Editor, blockId: string): number {
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

  function firstNodeOfType(editor: Editor, typeName: string): { pos: number; node: PMNode } | null {
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

  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
  });

  it("fillMediaNode: writeFile rejeitando (ACL negada) marca `error` no nó, não deixa `loading` preso", async () => {
    fsMock.writeFile.mockRejectedValue(new Error("Permission denied by ACL: fs.write_file not allowed"));

    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock(editor, "p1"));
    slashItem("blocks-media:video").run(editor);
    const before = firstNodeOfType(editor, "video");
    if (!before) throw new Error("bloco de vídeo não encontrado");

    await fillMediaNode(editor, before.pos, VIDEO_KIND, makeFile("aula.mp4", "video/mp4"));

    const after = firstNodeOfType(editor, "video");
    expect(after?.node.attrs.error).toBe("Falha ao salvar o arquivo.");
    expect(after?.node.attrs.loading).toBe(false);
    expect(after?.node.attrs.uploadToken).toBeNull();
    expect(after?.node.attrs.src).toBe("");
  });

  it("insertMediaFromFile: writeFile rejeitando também marca `error` no nó recém-inserido, não o deixa órfão em silêncio", async () => {
    fsMock.writeFile.mockRejectedValue(new Error("Permission denied by ACL: fs.write_file not allowed"));

    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock(editor, "p1"));

    const inserted = await insertMediaFromFile(editor, AUDIO_KIND, makeFile("podcast.mp3", "audio/mpeg"));

    expect(inserted).toBe(true);
    const after = firstNodeOfType(editor, "audio");
    expect(after?.node.attrs.error).toBe("Falha ao salvar o arquivo.");
    expect(after?.node.attrs.loading).toBe(false);
  });

  it("fillMediaNode: quando o plugin responde (mkdir/writeFile ok), o nó sai de \"Enviando…\" com `src` preenchido", async () => {
    editor = createEditor();
    editor.commands.setTextSelection(startOfBlock(editor, "p1"));
    slashItem("blocks-media:video").run(editor);
    const before = firstNodeOfType(editor, "video");
    if (!before) throw new Error("bloco de vídeo não encontrado");

    await fillMediaNode(editor, before.pos, VIDEO_KIND, makeFile("aula.mp4", "video/mp4"));

    const after = firstNodeOfType(editor, "video");
    expect(after?.node.attrs.error).toBeNull();
    expect(after?.node.attrs.loading).toBe(false);
    expect(String(after?.node.attrs.src)).not.toBe("");
  });
});
