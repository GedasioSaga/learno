import { beforeEach, describe, expect, it } from "vitest";
import { useRecuperacaoStore } from "./recuperacao-store";

beforeEach(() => {
  useRecuperacaoStore.setState({ ativo: false, revelados: new Set(), focoId: null });
});

describe("useRecuperacaoStore", () => {
  it("começa desligado, sem nada revelado e sem foco", () => {
    const estado = useRecuperacaoStore.getState();
    expect(estado.ativo).toBe(false);
    expect(estado.revelados.size).toBe(0);
    expect(estado.focoId).toBeNull();
  });

  it("iniciar liga o modo, zera revelados e põe o foco no id recebido", () => {
    useRecuperacaoStore.getState().iniciar("raiz");

    const estado = useRecuperacaoStore.getState();
    expect(estado.ativo).toBe(true);
    expect(estado.revelados.size).toBe(0);
    expect(estado.focoId).toBe("raiz");
  });

  it("iniciar de novo (nova passada) zera o que tinha sido revelado antes", () => {
    useRecuperacaoStore.getState().iniciar("raiz");
    useRecuperacaoStore.getState().revelar("filho-1");
    expect(useRecuperacaoStore.getState().revelados.has("filho-1")).toBe(true);

    useRecuperacaoStore.getState().iniciar("raiz");

    expect(useRecuperacaoStore.getState().revelados.has("filho-1")).toBe(false);
  });

  it("revelar acrescenta só o id pedido, sem afetar os demais", () => {
    useRecuperacaoStore.getState().iniciar("raiz");
    useRecuperacaoStore.getState().revelar("filho-1");

    const { revelados } = useRecuperacaoStore.getState();
    expect(revelados.has("filho-1")).toBe(true);
    expect(revelados.has("filho-2")).toBe(false);
    expect(revelados.size).toBe(1);
  });

  it("revelarTodos substitui o conjunto inteiro pelos ids recebidos", () => {
    useRecuperacaoStore.getState().iniciar("raiz");
    useRecuperacaoStore.getState().revelar("filho-1");

    useRecuperacaoStore.getState().revelarTodos(["filho-1", "filho-2", "filho-3"]);

    const { revelados } = useRecuperacaoStore.getState();
    expect(revelados.size).toBe(3);
    expect(revelados.has("filho-2")).toBe(true);
  });

  it("focar move o cursor de navegação sem mexer em revelados", () => {
    useRecuperacaoStore.getState().iniciar("raiz");
    useRecuperacaoStore.getState().revelar("filho-1");

    useRecuperacaoStore.getState().focar("filho-2");

    const estado = useRecuperacaoStore.getState();
    expect(estado.focoId).toBe("filho-2");
    expect(estado.revelados.has("filho-1")).toBe(true);
  });

  it("sair desliga o modo e descarta revelados/foco — é o que garante que reentrar começa do zero", () => {
    useRecuperacaoStore.getState().iniciar("raiz");
    useRecuperacaoStore.getState().revelar("filho-1");
    useRecuperacaoStore.getState().focar("filho-1");

    useRecuperacaoStore.getState().sair();

    const estado = useRecuperacaoStore.getState();
    expect(estado.ativo).toBe(false);
    expect(estado.revelados.size).toBe(0);
    expect(estado.focoId).toBeNull();
  });
});
