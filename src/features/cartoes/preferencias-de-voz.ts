import { create } from "zustand";

/**
 * Preferência de voz por BARALHO, não global e não cravada em inglês: o
 * mesmo usuário estuda inglês num baralho e programação/outras coisas em
 * outros — cada um pode ter idioma e voz diferentes, e cada baralho lembra a
 * sua.
 */
export interface PreferenciasDeVoz {
  /** BCP-47 (ex.: "en-US"). */
  idioma: string;
  /** `voiceURI` da voz escolhida, ou `null` para "a primeira do idioma". */
  vozURI: string | null;
  /**
   * Falar sozinho ao mostrar um cartão novo, sem o usuário pedir.
   * Desligado por padrão — som que dispara sozinho é o motivo mais fácil de
   * odiar num app de estudo, e é exatamente o que o pedido desta peça pede
   * para evitar.
   */
  falarAutomaticamente: boolean;
}

/** pt-BR: o idioma da própria UI, o palpite mais seguro para um baralho novo antes de o usuário escolher. */
export const IDIOMA_PADRAO = "pt-BR";

export const PREFERENCIAS_DE_VOZ_PADRAO: PreferenciasDeVoz = {
  idioma: IDIOMA_PADRAO,
  vozURI: null,
  falarAutomaticamente: false,
};

interface EstadoDePreferenciasDeVoz {
  porBaralho: Record<string, PreferenciasDeVoz>;
  definirIdioma: (deckId: string, idioma: string) => void;
  definirVoz: (deckId: string, vozURI: string | null) => void;
  alternarFalarAutomaticamente: (deckId: string) => void;
}

/**
 * Onde a preferência de voz de UM baralho sobrevive a reabrir o app.
 *
 * `localStorage`, não o banco: `decks` (`src-tauri/migrations/*.sql`) não tem
 * coluna para isto, e `src-tauri/src/db/pages.rs` / `db/mod.rs` / os arquivos
 * de baralho estão fora do alcance desta peça (outro workflow escreve neles
 * agora — ver o pedido). Mesmo padrão manual (ler defensivamente, nunca
 * lançar, cair no padrão) de `features/pages/page-preferences-store.ts` e
 * `features/navegacao/store.ts` — não zustand `persist()`, que nenhum store
 * deste projeto usa hoje.
 */
const CHAVE = "learno:preferencias-voz";

/** Lê uma entrada individual do JSON persistido, sem confiar em nenhum campo dela. */
function lerPreferencias(valor: unknown): PreferenciasDeVoz {
  if (typeof valor !== "object" || valor === null) return PREFERENCIAS_DE_VOZ_PADRAO;
  const idioma =
    "idioma" in valor && typeof valor.idioma === "string" && valor.idioma.trim() !== ""
      ? valor.idioma
      : PREFERENCIAS_DE_VOZ_PADRAO.idioma;
  const vozURI = "vozURI" in valor && typeof valor.vozURI === "string" ? valor.vozURI : null;
  const falarAutomaticamente =
    "falarAutomaticamente" in valor && typeof valor.falarAutomaticamente === "boolean" ? valor.falarAutomaticamente : false;
  return { idioma, vozURI, falarAutomaticamente };
}

/** Exportado para teste direto, no mesmo padrão de `page-preferences-store.ts`. */
export function lerPersistido(): Record<string, PreferenciasDeVoz> {
  try {
    const bruto = window.localStorage.getItem(CHAVE);
    if (bruto === null) return {};
    const lido: unknown = JSON.parse(bruto);
    if (typeof lido !== "object" || lido === null) return {};
    // `as Record<string, unknown>` só AMPLIA `object` (já confirmado não-nulo
    // acima) para indexação por chave dinâmica — nenhum campo do valor sob
    // cada chave é usado sem passar por `lerPreferencias`, que não confia em
    // nada do que lê.
    const mapa = lido as Record<string, unknown>;
    const porBaralho: Record<string, PreferenciasDeVoz> = {};
    for (const deckId of Object.keys(mapa)) {
      porBaralho[deckId] = lerPreferencias(mapa[deckId]);
    }
    return porBaralho;
  } catch {
    return {};
  }
}

function gravarPersistido(porBaralho: Record<string, PreferenciasDeVoz>) {
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify(porBaralho));
  } catch {
    // Storage indisponível: a preferência vale nesta sessão e volta ao
    // padrão na próxima abertura. Não é motivo para interromper o usuário.
  }
}

export const usePreferenciasDeVozStore = create<EstadoDePreferenciasDeVoz>((set, get) => ({
  porBaralho: lerPersistido(),

  definirIdioma: (deckId, idioma) => {
    const atual = get().porBaralho[deckId] ?? PREFERENCIAS_DE_VOZ_PADRAO;
    // Trocar de idioma invalida a voz específica escolhida antes: ela
    // pertencia ao idioma anterior e pode nem existir no novo.
    const porBaralho = { ...get().porBaralho, [deckId]: { ...atual, idioma, vozURI: null } };
    set({ porBaralho });
    gravarPersistido(porBaralho);
  },

  definirVoz: (deckId, vozURI) => {
    const atual = get().porBaralho[deckId] ?? PREFERENCIAS_DE_VOZ_PADRAO;
    const porBaralho = { ...get().porBaralho, [deckId]: { ...atual, vozURI } };
    set({ porBaralho });
    gravarPersistido(porBaralho);
  },

  alternarFalarAutomaticamente: (deckId) => {
    const atual = get().porBaralho[deckId] ?? PREFERENCIAS_DE_VOZ_PADRAO;
    const porBaralho = { ...get().porBaralho, [deckId]: { ...atual, falarAutomaticamente: !atual.falarAutomaticamente } };
    set({ porBaralho });
    gravarPersistido(porBaralho);
  },
}));

/** Preferências de voz do baralho, ou o padrão se ele nunca foi customizado. */
export function usePreferenciasDeVoz(deckId: string): PreferenciasDeVoz {
  return usePreferenciasDeVozStore((state) => state.porBaralho[deckId] ?? PREFERENCIAS_DE_VOZ_PADRAO);
}
