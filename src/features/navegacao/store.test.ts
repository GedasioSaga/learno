import { beforeEach, describe, expect, it } from "vitest";
import { lerPersistido, SECAO_PADRAO, useNavegacaoStore } from "./store";

const CHAVE = "learno:navegacao";

beforeEach(() => {
  localStorage.clear();
  useNavegacaoStore.setState({ secaoAtiva: SECAO_PADRAO, painelRecolhido: false, ultimaTrocaPor: null });
});

describe("lerPersistido", () => {
  it("sem nada salvo, abre na seção padrão com o painel visível", () => {
    expect(lerPersistido()).toEqual({ secaoAtiva: SECAO_PADRAO, painelRecolhido: false });
  });

  it("devolve o que ficou salvo quando é válido", () => {
    localStorage.setItem(CHAVE, JSON.stringify({ secaoAtiva: "cartoes", painelRecolhido: true }));
    expect(lerPersistido()).toEqual({ secaoAtiva: "cartoes", painelRecolhido: true });
  });

  it("um id de seção que não existe mais cai no padrão, sem derrubar o painel salvo", () => {
    localStorage.setItem(CHAVE, JSON.stringify({ secaoAtiva: "fluxograma", painelRecolhido: true }));
    expect(lerPersistido()).toEqual({ secaoAtiva: SECAO_PADRAO, painelRecolhido: true });
  });

  it("JSON corrompido ou de outra forma cai no padrão em vez de lançar", () => {
    localStorage.setItem(CHAVE, "{isto não é json");
    expect(lerPersistido()).toEqual({ secaoAtiva: SECAO_PADRAO, painelRecolhido: false });

    localStorage.setItem(CHAVE, JSON.stringify("cartoes"));
    expect(lerPersistido()).toEqual({ secaoAtiva: SECAO_PADRAO, painelRecolhido: false });

    localStorage.setItem(CHAVE, JSON.stringify({ secaoAtiva: 7, painelRecolhido: "sim" }));
    expect(lerPersistido()).toEqual({ secaoAtiva: SECAO_PADRAO, painelRecolhido: false });
  });
});

describe("useNavegacaoStore", () => {
  it("irPara troca a seção, registra a origem e grava para a próxima abertura", () => {
    useNavegacaoStore.getState().irPara("mapa-mental", "teclado");

    expect(useNavegacaoStore.getState().secaoAtiva).toBe("mapa-mental");
    expect(useNavegacaoStore.getState().ultimaTrocaPor).toBe("teclado");
    expect(lerPersistido()).toEqual({ secaoAtiva: "mapa-mental", painelRecolhido: false });
  });

  it("irPara sem origem conta como ponteiro (o caso do clique)", () => {
    useNavegacaoStore.getState().irPara("trilha");
    expect(useNavegacaoStore.getState().ultimaTrocaPor).toBe("ponteiro");
  });

  it("irPara na seção que já está ativa não mexe em nada — nem re-anima", () => {
    useNavegacaoStore.getState().irPara(SECAO_PADRAO, "ponteiro");
    expect(useNavegacaoStore.getState().ultimaTrocaPor).toBeNull();
    expect(localStorage.getItem(CHAVE)).toBeNull();
  });

  it("alternarPainel inverte e persiste junto com a seção ativa", () => {
    useNavegacaoStore.getState().irPara("cartoes");
    useNavegacaoStore.getState().alternarPainel();

    expect(useNavegacaoStore.getState().painelRecolhido).toBe(true);
    expect(lerPersistido()).toEqual({ secaoAtiva: "cartoes", painelRecolhido: true });

    useNavegacaoStore.getState().alternarPainel();
    expect(lerPersistido()).toEqual({ secaoAtiva: "cartoes", painelRecolhido: false });
  });
});
