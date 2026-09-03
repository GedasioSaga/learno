import { create } from "zustand";

export type ThemePreference = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

const STORAGE_KEY = "learno:theme-preference";

/** Lê a preferência salva. Nunca lança: ambiente sem `localStorage` (ou com
 * acesso bloqueado) só cai de volta no padrão do sistema. */
export function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Storage indisponível — segue com o padrão abaixo.
  }
  return "system";
}

export function resolveEffectiveTheme(preference: ThemePreference): EffectiveTheme {
  if (preference !== "system") return preference;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  return prefersDark ? "dark" : "light";
}

function applyToDocument(effective: EffectiveTheme) {
  document.documentElement.dataset.theme = effective;
}

interface ThemeState {
  preference: ThemePreference;
  effective: EffectiveTheme;
  /** Aplica a preferência salva (ou o padrão do sistema) ao documento. Chamado
   * uma vez, na inicialização do app — não no carregamento do módulo, pra não
   * ter efeito colateral em quem só importa os tipos/funções puras daqui. */
  init: () => void;
  setPreference: (preference: ThemePreference) => void;
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: "system",
  effective: "light",
  init: () => {
    const preference = readStoredPreference();
    const effective = resolveEffectiveTheme(preference);
    applyToDocument(effective);
    set({ preference, effective });
  },
  setPreference: (preference) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // A escolha não sobrevive à próxima sessão, mas a troca de agora funciona igual.
    }
    const effective = resolveEffectiveTheme(preference);
    applyToDocument(effective);
    set({ preference, effective });
  },
  toggle: () => {
    const nextPreference: ThemePreference = get().effective === "dark" ? "light" : "dark";
    get().setPreference(nextPreference);
  },
}));
