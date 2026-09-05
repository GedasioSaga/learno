/**
 * `storeMediaFile`/`resolveMediaSrc` fora do Tauri - o modo que roda neste
 * teste (jsdom, `isTauri()` sempre `false`) e no `vite dev` normal. O ramo
 * de arquivo real (dentro do Tauri, com `@tauri-apps/plugin-fs`) não tem
 * como ser exercitado aqui - ver o relatório sobre o que ficou fora do
 * alcance deste teste.
 */
import { describe, expect, it } from "vitest";
import { isExternalMediaUrl, resolveMediaSrc, storeMediaFile } from "./media-storage";

function makeFile(name: string, type: string, content = "conteúdo"): File {
  return new File([content], name, { type });
}

describe("storeMediaFile / resolveMediaSrc (fora do Tauri)", () => {
  it("grava um arquivo e a mesma chave resolve para a mesma URL depois", async () => {
    const file = makeFile("foto.png", "image/png");
    const stored = await storeMediaFile(file);

    expect(stored.src).toBeTruthy();
    expect(stored.url).toBeTruthy();

    const resolved = await resolveMediaSrc(stored.src);
    expect(resolved).toBe(stored.url);
  });

  it("duas gravações do mesmo File recebem chaves diferentes (sem hash fora do Tauri)", async () => {
    const file = makeFile("foto.png", "image/png");
    const first = await storeMediaFile(file);
    const second = await storeMediaFile(file);
    expect(first.src).not.toBe(second.src);
  });

  it("uma chave nunca gravada nesta sessão resolve para string vazia, não lança", async () => {
    expect(await resolveMediaSrc("blob:desconhecida.png")).toBe("");
  });

  it("string vazia resolve para string vazia (bloco ainda sem arquivo)", async () => {
    expect(await resolveMediaSrc("")).toBe("");
  });
});

describe("isExternalMediaUrl / URL direta (EDT-024: aceita URL)", () => {
  it("reconhece http, https e data: como externas", () => {
    expect(isExternalMediaUrl("https://exemplo.test/foto.png")).toBe(true);
    expect(isExternalMediaUrl("http://exemplo.test/foto.png")).toBe(true);
    expect(isExternalMediaUrl("data:image/png;base64,abc")).toBe(true);
  });

  it("uma chave de storage local não é externa", () => {
    expect(isExternalMediaUrl("blob:abc123.png")).toBe(false);
    expect(isExternalMediaUrl("d34db33f.png")).toBe(false);
  });

  it("uma URL externa passa por resolveMediaSrc sem alteração", async () => {
    const url = "https://exemplo.test/foto.png";
    expect(await resolveMediaSrc(url)).toBe(url);
  });
});
