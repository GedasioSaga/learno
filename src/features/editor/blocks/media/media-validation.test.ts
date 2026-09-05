import { describe, expect, it } from "vitest";
import { IMAGE_MAX_BYTES, IMAGE_MIME_TYPES, validateMediaFile } from "./media-validation";

function makeFile(name: string, type: string, sizeBytes: number): File {
  // `File` calcula `size` a partir do conteúdo real - um array de bytes do
  // tamanho pedido é a forma mais direta de simular "arquivo grande" sem
  // depender de nenhuma opção especial do construtor.
  const bytes = sizeBytes > 0 ? new Uint8Array(sizeBytes) : new Uint8Array(0);
  return new File([bytes], name, { type });
}

describe("validateMediaFile (EDT-024/025/026/027: tipo MIME e teto de tamanho)", () => {
  it("aceita um arquivo dentro do tipo e do tamanho esperados", () => {
    const file = makeFile("foto.png", "image/png", 1024);
    expect(validateMediaFile(file, IMAGE_MIME_TYPES, IMAGE_MAX_BYTES)).toEqual({ ok: true });
  });

  it("recusa um arquivo vazio", () => {
    const file = makeFile("vazio.png", "image/png", 0);
    const result = validateMediaFile(file, IMAGE_MIME_TYPES, IMAGE_MAX_BYTES);
    expect(result.ok).toBe(false);
  });

  it("recusa um arquivo maior que o limite declarado", () => {
    const file = makeFile("gigante.png", "image/png", IMAGE_MAX_BYTES + 1);
    const result = validateMediaFile(file, IMAGE_MIME_TYPES, IMAGE_MAX_BYTES);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/limite/);
  });

  it("recusa um tipo MIME fora da allowlist (um .exe disfarçado de imagem)", () => {
    const file = makeFile("script.png", "application/x-msdownload", 1024);
    const result = validateMediaFile(file, IMAGE_MIME_TYPES, IMAGE_MAX_BYTES);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/não é aceito/);
  });

  it("allowlist nula (bloco de arquivo) aceita qualquer MIME, só o tamanho importa", () => {
    const file = makeFile("relatorio.pdf", "application/pdf", 1024);
    expect(validateMediaFile(file, null, IMAGE_MAX_BYTES)).toEqual({ ok: true });
  });
});
