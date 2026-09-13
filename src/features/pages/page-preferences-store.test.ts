import { beforeEach, describe, expect, it } from "vitest";
import { lerPersistido, PREFERENCIAS_PADRAO, usePagePreferencesStore } from "./page-preferences-store";

const CHAVE = "learno:preferencias-pagina";

beforeEach(() => {
  localStorage.clear();
  usePagePreferencesStore.setState({ porPagina: {} });
});

describe("lerPersistido", () => {
  it("sem nada salvo, devolve um mapa vazio", () => {
    expect(lerPersistido()).toEqual({});
  });

  it("devolve o que ficou salvo quando é válido", () => {
    localStorage.setItem(
      CHAVE,
      JSON.stringify({ p1: { fonte: "mono", textoPequeno: true, larguraTotal: false } }),
    );
    expect(lerPersistido()).toEqual({ p1: { fonte: "mono", textoPequeno: true, larguraTotal: false } });
  });

  it("uma fonte desconhecida cai em 'padrao', sem derrubar os outros dois campos", () => {
    localStorage.setItem(
      CHAVE,
      JSON.stringify({ p1: { fonte: "cursiva", textoPequeno: true, larguraTotal: true } }),
    );
    expect(lerPersistido()).toEqual({ p1: { fonte: "padrao", textoPequeno: true, larguraTotal: true } });
  });

  it("JSON corrompido ou de outra forma cai num mapa vazio em vez de lançar", () => {
    localStorage.setItem(CHAVE, "{isto não é json");
    expect(lerPersistido()).toEqual({});

    localStorage.setItem(CHAVE, JSON.stringify("mono"));
    expect(lerPersistido()).toEqual({});

    localStorage.setItem(CHAVE, JSON.stringify({ p1: "mono" }));
    expect(lerPersistido()).toEqual({ p1: PREFERENCIAS_PADRAO });
  });
});

describe("usePagePreferencesStore", () => {
  it("definirFonte muda só a fonte da página indicada e persiste", () => {
    usePagePreferencesStore.getState().definirFonte("p1", "serifada");

    expect(usePagePreferencesStore.getState().porPagina.p1).toEqual({
      fonte: "serifada",
      textoPequeno: false,
      larguraTotal: false,
    });
    expect(lerPersistido()).toEqual({ p1: { fonte: "serifada", textoPequeno: false, larguraTotal: false } });
  });

  it("alternarTextoPequeno inverte, e uma segunda chamada volta ao estado anterior", () => {
    usePagePreferencesStore.getState().alternarTextoPequeno("p1");
    expect(usePagePreferencesStore.getState().porPagina.p1?.textoPequeno).toBe(true);

    usePagePreferencesStore.getState().alternarTextoPequeno("p1");
    expect(usePagePreferencesStore.getState().porPagina.p1?.textoPequeno).toBe(false);
  });

  it("alternarLarguraTotal inverte e persiste sem mexer na fonte já escolhida", () => {
    usePagePreferencesStore.getState().definirFonte("p1", "mono");
    usePagePreferencesStore.getState().alternarLarguraTotal("p1");

    expect(lerPersistido()).toEqual({ p1: { fonte: "mono", textoPequeno: false, larguraTotal: true } });
  });

  it("páginas diferentes guardam preferências independentes", () => {
    usePagePreferencesStore.getState().definirFonte("p1", "mono");
    usePagePreferencesStore.getState().alternarTextoPequeno("p2");

    expect(usePagePreferencesStore.getState().porPagina.p1?.fonte).toBe("mono");
    expect(usePagePreferencesStore.getState().porPagina.p2?.textoPequeno).toBe(true);
    expect(usePagePreferencesStore.getState().porPagina.p2?.fonte).toBe("padrao");
  });
});
