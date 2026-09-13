import { create } from "zustand";

/**
 * FUN-017: os três estilos tipográficos que uma página pode escolher, no
 * modelo Default/Serif/Mono do Notion que o usuário mostrou. Chave em
 * português (a UI não vaza inglês), array primeiro para o menu iterar sem
 * repetir a lista em dois lugares.
 */
export const FONTES_DA_PAGINA = ["padrao", "serifada", "mono"] as const;
export type FontePagina = (typeof FONTES_DA_PAGINA)[number];

export const FONTE_LABELS: Record<FontePagina, string> = {
  padrao: "Padrão",
  serifada: "Serifada",
  mono: "Mono",
};

export interface PreferenciasDaPagina {
  fonte: FontePagina;
  /** FUN-018 — reduz o tamanho de toda a página. */
  textoPequeno: boolean;
  /** FUN-016 — remove a régua de leitura de 65ch (`--measure`). */
  larguraTotal: boolean;
}

export const PREFERENCIAS_PADRAO: PreferenciasDaPagina = {
  fonte: "padrao",
  textoPequeno: false,
  larguraTotal: false,
};

interface EstadoDePreferencias {
  porPagina: Record<string, PreferenciasDaPagina>;
  definirFonte: (pageId: string, fonte: FontePagina) => void;
  alternarTextoPequeno: (pageId: string) => void;
  alternarLarguraTotal: (pageId: string) => void;
}

/**
 * Onde a preferência de fonte/tamanho/largura de UMA página sobrevive a
 * reabrir o app.
 *
 * `localStorage`, não o banco: `pages` (`src-tauri/migrations/*.sql`) não tem
 * coluna para nenhuma das três, e criar uma migração está fora do alcance
 * deste trabalho — o schema SQLite é de outro workflow rodando em paralelo.
 * Isto é o degrau "por enquanto": a preferência funciona e sobrevive a fechar
 * o app, mas não é copiada por um backup do banco (`VACUUM INTO`), não
 * sincroniza entre máquinas, e some se o usuário limpar dados do site — ver o
 * relatório desta tarefa para o registro completo dessa lacuna. Quando
 * `pages` ganhar as colunas (ex.: `font`, `small_text`, `full_width`), a
 * migração é trocar `lerPersistido`/`gravarPersistido` por chamadas de IPC —
 * `PreferenciasDaPagina` já é a forma que essas colunas teriam.
 *
 * Mesmo padrão manual (ler defensivamente, nunca lançar, cair no padrão) que
 * `features/navegacao/store.ts` já usa — não zustand `persist()`, que nenhum
 * store deste projeto usa hoje.
 */
const CHAVE = "learno:preferencias-pagina";

function ehFontePagina(valor: unknown): valor is FontePagina {
  return typeof valor === "string" && (FONTES_DA_PAGINA as readonly string[]).includes(valor);
}

/** Lê uma entrada individual do JSON persistido, sem confiar em nenhum campo dela. */
function lerPreferencias(valor: unknown): PreferenciasDaPagina {
  if (typeof valor !== "object" || valor === null) return PREFERENCIAS_PADRAO;
  const fonte = "fonte" in valor && ehFontePagina(valor.fonte) ? valor.fonte : PREFERENCIAS_PADRAO.fonte;
  const textoPequeno = "textoPequeno" in valor && typeof valor.textoPequeno === "boolean" ? valor.textoPequeno : false;
  const larguraTotal = "larguraTotal" in valor && typeof valor.larguraTotal === "boolean" ? valor.larguraTotal : false;
  return { fonte, textoPequeno, larguraTotal };
}

/** Exportado para teste direto, no mesmo padrão de `navegacao/store.ts`. */
export function lerPersistido(): Record<string, PreferenciasDaPagina> {
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
    const porPagina: Record<string, PreferenciasDaPagina> = {};
    for (const pageId of Object.keys(mapa)) {
      porPagina[pageId] = lerPreferencias(mapa[pageId]);
    }
    return porPagina;
  } catch {
    return {};
  }
}

function gravarPersistido(porPagina: Record<string, PreferenciasDaPagina>) {
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify(porPagina));
  } catch {
    // Storage indisponível: a preferência vale nesta sessão e volta ao
    // padrão na próxima abertura. Não é motivo para interromper o usuário.
  }
}

export const usePagePreferencesStore = create<EstadoDePreferencias>((set, get) => ({
  porPagina: lerPersistido(),

  definirFonte: (pageId, fonte) => {
    const atual = get().porPagina[pageId] ?? PREFERENCIAS_PADRAO;
    const porPagina = { ...get().porPagina, [pageId]: { ...atual, fonte } };
    set({ porPagina });
    gravarPersistido(porPagina);
  },

  alternarTextoPequeno: (pageId) => {
    const atual = get().porPagina[pageId] ?? PREFERENCIAS_PADRAO;
    const porPagina = { ...get().porPagina, [pageId]: { ...atual, textoPequeno: !atual.textoPequeno } };
    set({ porPagina });
    gravarPersistido(porPagina);
  },

  alternarLarguraTotal: (pageId) => {
    const atual = get().porPagina[pageId] ?? PREFERENCIAS_PADRAO;
    const porPagina = { ...get().porPagina, [pageId]: { ...atual, larguraTotal: !atual.larguraTotal } };
    set({ porPagina });
    gravarPersistido(porPagina);
  },
}));

/** Preferências da página, ou o padrão se ela nunca foi customizada. */
export function usePreferenciasDaPagina(pageId: string): PreferenciasDaPagina {
  return usePagePreferencesStore((state) => state.porPagina[pageId] ?? PREFERENCIAS_PADRAO);
}
