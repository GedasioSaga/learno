import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acharTema,
  alternarClaroEscuro,
  ehPreferenciaValida,
  resolverTema,
  SEGUIR_O_SISTEMA,
  TEMAS,
  TEMA_CLARO_DO_SISTEMA,
  TEMA_PADRAO,
} from "./themes";

/** Finge o que o sistema operacional responde a `prefers-color-scheme`. */
function sistemaNoEscuro(escuro: boolean) {
  vi.stubGlobal("matchMedia", (consulta: string) => ({
    matches: consulta.includes("dark") && escuro,
    media: consulta,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catálogo", () => {
  it("todo tema tem id, nome e aparência, e nenhum id se repete", () => {
    const ids = TEMAS.map((tema) => tema.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tema of TEMAS) {
      expect(tema.id).toMatch(/^[a-z0-9-]+$/);
      expect(tema.nome.length).toBeGreaterThan(0);
      expect(["clara", "escura"]).toContain(tema.aparencia);
    }
  });

  /// O id vai para o `config.json` passando por `config::validate_theme_id`
  /// no Rust, que só aceita minúscula, dígito e hífen. Um id fora dessa forma
  /// seria recusado ao salvar e a escolha do usuário sumiria em silêncio.
  it("todo id passa na validação de forma que o backend aplica", () => {
    for (const tema of TEMAS) {
      expect(tema.id).toMatch(/^[a-z0-9-]{1,40}$/);
    }
  });

  it("existe pelo menos um tema claro e um escuro, senão alternar não faz sentido", () => {
    expect(TEMAS.some((tema) => tema.aparencia === "clara")).toBe(true);
    expect(TEMAS.some((tema) => tema.aparencia === "escura")).toBe(true);
  });

  it("o padrão e os alvos de 'seguir o sistema' existem no catálogo", () => {
    expect(acharTema(TEMA_PADRAO)).toBeDefined();
    expect(acharTema(TEMA_CLARO_DO_SISTEMA)?.aparencia).toBe("clara");
  });
});

describe("ehPreferenciaValida", () => {
  it("aceita um id do catálogo e o valor de seguir o sistema", () => {
    expect(ehPreferenciaValida("papel")).toBe(true);
    expect(ehPreferenciaValida(SEGUIR_O_SISTEMA)).toBe(true);
  });

  /// Os valores da versão anterior do app. Aceitá-los escreveria
  /// `data-theme="dark"`, que não casa nenhum bloco de tema e deixaria a
  /// interface com as cores do `:root` sem ninguém entender por quê.
  it("recusa as preferências da versão antiga e qualquer lixo", () => {
    expect(ehPreferenciaValida("dark")).toBe(false);
    expect(ehPreferenciaValida("light")).toBe(false);
    expect(ehPreferenciaValida("system")).toBe(false);
    expect(ehPreferenciaValida(null)).toBe(false);
    expect(ehPreferenciaValida(42)).toBe(false);
    expect(ehPreferenciaValida("")).toBe(false);
  });
});

describe("resolverTema", () => {
  it("uma escolha explícita é o próprio tema", () => {
    expect(resolverTema("grafite")).toBe("grafite");
  });

  it("seguir o sistema olha o sistema", () => {
    sistemaNoEscuro(true);
    expect(acharTema(resolverTema(SEGUIR_O_SISTEMA))?.aparencia).toBe("escura");

    sistemaNoEscuro(false);
    expect(acharTema(resolverTema(SEGUIR_O_SISTEMA))?.aparencia).toBe("clara");
  });

  it("sem matchMedia (jsdom cru), seguir o sistema cai no claro em vez de quebrar", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolverTema(SEGUIR_O_SISTEMA)).toBe(TEMA_CLARO_DO_SISTEMA);
  });

  it("um id desconhecido cai no padrão, nunca num data-theme que não pinta nada", () => {
    expect(resolverTema("tema-que-nao-existe")).toBe(TEMA_PADRAO);
  });
});

describe("alternarClaroEscuro", () => {
  it("do escuro vai para o claro", () => {
    expect(alternarClaroEscuro("ambar-noturno")).toBe(TEMA_CLARO_DO_SISTEMA);
  });

  it("do claro volta para o último escuro em uso, não para o padrão", () => {
    expect(alternarClaroEscuro("papel", "meia-noite")).toBe("meia-noite");
  });

  it("do claro sem último escuro conhecido, volta para o padrão", () => {
    expect(alternarClaroEscuro("papel")).toBe(TEMA_PADRAO);
  });

  it("um último escuro que na verdade é claro não engana a volta", () => {
    // Defesa contra estado inconsistente: se algo gravou um tema claro em
    // `ultimoEscuro`, alternar do claro devolveria o claro e o botão pareceria
    // quebrado.
    expect(alternarClaroEscuro("papel", "papel")).toBe(TEMA_PADRAO);
  });
});
