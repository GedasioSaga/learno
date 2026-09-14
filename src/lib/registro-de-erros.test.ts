import { beforeEach, describe, expect, it, vi } from "vitest";
import { registrarErroDaInterface } from "./ipc";
import {
  descreverErro,
  esquecerUltimoErro,
  instalarRegistroDeErros,
  JANELA_DE_REPETICAO_MS,
  registrarErro,
} from "./registro-de-erros";

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return { ...actual, registrarErroDaInterface: vi.fn() };
});

const registrarMock = vi.mocked(registrarErroDaInterface);

beforeEach(() => {
  registrarMock.mockReset();
  registrarMock.mockResolvedValue(undefined);
  esquecerUltimoErro();
});

describe("descreverErro", () => {
  it("Error vira nome, mensagem e pilha", () => {
    const erro = new TypeError("x is undefined");
    expect(descreverErro(erro)).toEqual({ mensagem: "TypeError: x is undefined", pilha: erro.stack });
  });

  it("texto, objeto e undefined viram mensagem sem pilha", () => {
    expect(descreverErro("falhou")).toEqual({ mensagem: "falhou", pilha: null });
    expect(descreverErro({ codigo: 42 })).toEqual({ mensagem: '{"codigo":42}', pilha: null });
    expect(descreverErro(undefined)).toEqual({ mensagem: "undefined", pilha: null });
  });

  it("objeto circular não quebra a descrição", () => {
    const circular: Record<string, unknown> = {};
    circular.eu = circular;
    expect(descreverErro(circular).mensagem).toBe("[object Object]");
  });
});

describe("registrarErro", () => {
  it("manda origem, mensagem e pilha ao backend", () => {
    registrarErro("tela", new Error("quebrou"), 1_000);

    expect(registrarMock).toHaveBeenCalledWith("tela", "Error: quebrou", expect.stringContaining("quebrou"));
  });

  it("o mesmo erro repetido dentro da janela vira uma linha só", () => {
    registrarErro("janela", "igual", 1_000);
    registrarErro("janela", "igual", 1_000 + JANELA_DE_REPETICAO_MS - 1);
    expect(registrarMock).toHaveBeenCalledTimes(1);

    registrarErro("janela", "igual", 1_000 + JANELA_DE_REPETICAO_MS);
    expect(registrarMock).toHaveBeenCalledTimes(2);
  });

  it("erro diferente, ou de outra origem, registra na hora", () => {
    registrarErro("janela", "um", 1_000);
    registrarErro("janela", "outro", 1_001);
    registrarErro("promessa", "outro", 1_002);

    expect(registrarMock).toHaveBeenCalledTimes(3);
  });

  it("backend fora do ar não vira erro nem rejeição solta", async () => {
    registrarMock.mockRejectedValue(new Error("fora do Tauri"));
    expect(() => registrarErro("tela", "algo", 1_000)).not.toThrow();

    registrarMock.mockImplementation(() => {
      throw new Error("sem invoke");
    });
    expect(() => registrarErro("tela", "outro", 1_001)).not.toThrow();

    // Uma rejeição sem tratamento faria o vitest falhar este arquivo.
    await new Promise((resolver) => setTimeout(resolver, 0));
  });
});

// Um alvo próprio, e não a `window`: o vitest escuta os erros da `window` do
// jsdom e trata um `ErrorEvent` disparado nela como erro não tratado do teste.
describe("instalarRegistroDeErros", () => {
  it("erro solto na janela é registrado, e deixa de ser depois de desligar", () => {
    const alvo = new EventTarget();
    const desligar = instalarRegistroDeErros(alvo);
    alvo.dispatchEvent(new ErrorEvent("error", { error: new Error("solto"), message: "solto" }));
    expect(registrarMock).toHaveBeenCalledWith("janela", "Error: solto", expect.any(String));

    desligar();
    alvo.dispatchEvent(new ErrorEvent("error", { error: new Error("depois"), message: "depois" }));
    expect(registrarMock).toHaveBeenCalledTimes(1);
  });

  it("erro de script sem objeto de erro usa a mensagem do evento", () => {
    const alvo = new EventTarget();
    const desligar = instalarRegistroDeErros(alvo);
    alvo.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    desligar();

    expect(registrarMock).toHaveBeenCalledWith("janela", "Script error.", null);
  });

  it("promessa rejeitada sem tratamento é registrada com o motivo", () => {
    const alvo = new EventTarget();
    const desligar = instalarRegistroDeErros(alvo);
    const evento = new Event("unhandledrejection");
    Object.defineProperty(evento, "reason", { value: new Error("rejeitada") });
    alvo.dispatchEvent(evento);
    desligar();

    expect(registrarMock).toHaveBeenCalledWith("promessa", "Error: rejeitada", expect.any(String));
  });
});
