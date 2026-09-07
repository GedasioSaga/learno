import { beforeEach, describe, expect, it } from "vitest";
import { lerPersistido, PREFERENCIAS_DE_VOZ_PADRAO, usePreferenciasDeVozStore } from "./preferencias-de-voz";

const CHAVE = "learno:preferencias-voz";

beforeEach(() => {
  localStorage.clear();
  usePreferenciasDeVozStore.setState({ porBaralho: {} });
});

describe("lerPersistido", () => {
  it("sem nada salvo, devolve um mapa vazio", () => {
    expect(lerPersistido()).toEqual({});
  });

  it("devolve o que ficou salvo quando é válido", () => {
    localStorage.setItem(
      CHAVE,
      JSON.stringify({ "deck-1": { idioma: "en-US", vozURI: "zira", falarAutomaticamente: true } }),
    );
    expect(lerPersistido()).toEqual({ "deck-1": { idioma: "en-US", vozURI: "zira", falarAutomaticamente: true } });
  });

  it("idioma ausente ou vazio cai no padrão, sem derrubar os outros campos", () => {
    localStorage.setItem(CHAVE, JSON.stringify({ "deck-1": { idioma: "", vozURI: "zira", falarAutomaticamente: true } }));
    expect(lerPersistido()).toEqual({
      "deck-1": { idioma: PREFERENCIAS_DE_VOZ_PADRAO.idioma, vozURI: "zira", falarAutomaticamente: true },
    });
  });

  it("JSON corrompido ou de outra forma cai num mapa vazio em vez de lançar", () => {
    localStorage.setItem(CHAVE, "{isto não é json");
    expect(lerPersistido()).toEqual({});

    localStorage.setItem(CHAVE, JSON.stringify("en-US"));
    expect(lerPersistido()).toEqual({});

    localStorage.setItem(CHAVE, JSON.stringify({ "deck-1": "en-US" }));
    expect(lerPersistido()).toEqual({ "deck-1": PREFERENCIAS_DE_VOZ_PADRAO });
  });
});

describe("usePreferenciasDeVozStore", () => {
  it("definirIdioma muda o idioma do baralho indicado, persiste, e ZERA a voz específica escolhida antes", () => {
    usePreferenciasDeVozStore.getState().definirVoz("deck-1", "zira");
    usePreferenciasDeVozStore.getState().definirIdioma("deck-1", "en-US");

    expect(usePreferenciasDeVozStore.getState().porBaralho["deck-1"]).toEqual({
      idioma: "en-US",
      vozURI: null,
      falarAutomaticamente: false,
    });
    expect(lerPersistido()["deck-1"]?.vozURI).toBeNull();
  });

  it("definirVoz muda só a voz, sem mexer no idioma nem em falarAutomaticamente", () => {
    usePreferenciasDeVozStore.getState().definirIdioma("deck-1", "en-US");
    usePreferenciasDeVozStore.getState().alternarFalarAutomaticamente("deck-1");

    usePreferenciasDeVozStore.getState().definirVoz("deck-1", "david");

    expect(lerPersistido()["deck-1"]).toEqual({ idioma: "en-US", vozURI: "david", falarAutomaticamente: true });
  });

  it("alternarFalarAutomaticamente inverte, e uma segunda chamada volta ao estado anterior", () => {
    usePreferenciasDeVozStore.getState().alternarFalarAutomaticamente("deck-1");
    expect(usePreferenciasDeVozStore.getState().porBaralho["deck-1"]?.falarAutomaticamente).toBe(true);

    usePreferenciasDeVozStore.getState().alternarFalarAutomaticamente("deck-1");
    expect(usePreferenciasDeVozStore.getState().porBaralho["deck-1"]?.falarAutomaticamente).toBe(false);
  });

  it("baralhos diferentes guardam preferências independentes — inglês num, sem mexer no resto", () => {
    usePreferenciasDeVozStore.getState().definirIdioma("deck-ingles", "en-US");
    usePreferenciasDeVozStore.getState().definirIdioma("deck-programacao", "pt-BR");

    expect(usePreferenciasDeVozStore.getState().porBaralho["deck-ingles"]?.idioma).toBe("en-US");
    expect(usePreferenciasDeVozStore.getState().porBaralho["deck-programacao"]?.idioma).toBe("pt-BR");
  });
});
