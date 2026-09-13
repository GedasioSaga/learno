import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTheme, saveTheme } from "./ipc";
import { useThemeStore } from "./theme-store";
import { TEMA_PADRAO } from "./themes";

vi.mock("./ipc", () => ({
  getTheme: vi.fn(),
  saveTheme: vi.fn(),
}));

const getThemeMock = vi.mocked(getTheme);
const saveThemeMock = vi.mocked(saveTheme);

/** Deixa o store no estado de processo recém-aberto, antes de `iniciar()`. */
function zerar() {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  useThemeStore.setState({
    preferencia: TEMA_PADRAO,
    temaEfetivo: TEMA_PADRAO,
    ultimoEscuro: TEMA_PADRAO,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getThemeMock.mockResolvedValue(null);
  saveThemeMock.mockResolvedValue(undefined);
  zerar();
});

describe("iniciar", () => {
  it("numa instalação nova, pinta o tema padrão do produto", () => {
    useThemeStore.getState().iniciar();
    expect(document.documentElement.dataset.theme).toBe(TEMA_PADRAO);
  });

  /// O ponto do cache: ele é síncrono, e por isso pinta ANTES do primeiro
  /// quadro. Ler o disco é IPC e chegaria tarde demais.
  it("aplica o cache local de forma síncrona, sem esperar o disco", () => {
    localStorage.setItem("learno:theme-preference", "grafite");

    useThemeStore.getState().iniciar();

    expect(document.documentElement.dataset.theme).toBe("grafite");
    expect(getThemeMock).toHaveBeenCalled();
  });

  it("o disco corrige o cache quando os dois discordam", async () => {
    localStorage.setItem("learno:theme-preference", "grafite");
    getThemeMock.mockResolvedValue("meia-noite");

    useThemeStore.getState().iniciar();
    expect(document.documentElement.dataset.theme).toBe("grafite");

    await vi.waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("meia-noite");
    });
    // E o cache passa a concordar, senão a correção se repetiria a cada boot.
    expect(localStorage.getItem("learno:theme-preference")).toBe("meia-noite");
  });

  it("a correção do disco não regrava no disco — ela veio de lá", async () => {
    getThemeMock.mockResolvedValue("papel");

    useThemeStore.getState().iniciar();

    await vi.waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("papel");
    });
    expect(saveThemeMock).not.toHaveBeenCalled();
  });

  it("sem runtime Tauri, o cache continua valendo em vez de o app ficar sem tema", async () => {
    localStorage.setItem("learno:theme-preference", "papel");
    getThemeMock.mockRejectedValue(new Error("sem runtime Tauri"));

    useThemeStore.getState().iniciar();
    await Promise.resolve();

    expect(document.documentElement.dataset.theme).toBe("papel");
  });

  /// Quem usava a versão anterior tem `"dark"`/`"light"`/`"system"` gravado.
  /// Aceitar isso escreveria um `data-theme` que não casa nenhum bloco.
  it("descarta a preferência da versão antiga e abre no padrão", () => {
    localStorage.setItem("learno:theme-preference", "dark");

    useThemeStore.getState().iniciar();

    expect(document.documentElement.dataset.theme).toBe(TEMA_PADRAO);
  });

  it("localStorage indisponível não impede o app de abrir", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("acesso a storage bloqueado");
    };
    try {
      useThemeStore.getState().iniciar();
      expect(document.documentElement.dataset.theme).toBe(TEMA_PADRAO);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe("escolher", () => {
  it("pinta, guarda no cache e persiste no disco", () => {
    useThemeStore.getState().escolher("meia-noite");

    expect(document.documentElement.dataset.theme).toBe("meia-noite");
    expect(localStorage.getItem("learno:theme-preference")).toBe("meia-noite");
    expect(saveThemeMock).toHaveBeenCalledWith("meia-noite");
  });

  it("ignora um id que não existe, em vez de apagar o tema atual", () => {
    useThemeStore.getState().escolher("grafite");
    useThemeStore.getState().escolher("tema-inventado");

    expect(document.documentElement.dataset.theme).toBe("grafite");
    expect(saveThemeMock).toHaveBeenCalledTimes(1);
  });

  it("lembra o último escuro, para a volta do claro devolver ele", () => {
    useThemeStore.getState().escolher("meia-noite");
    useThemeStore.getState().escolher("papel");

    expect(useThemeStore.getState().ultimoEscuro).toBe("meia-noite");
  });

  it("uma falha ao persistir não desfaz a troca que o usuário já está vendo", async () => {
    saveThemeMock.mockRejectedValue(new Error("disco cheio"));

    useThemeStore.getState().escolher("grafite");
    await Promise.resolve();

    expect(document.documentElement.dataset.theme).toBe("grafite");
  });
});

describe("alternar", () => {
  it("vai do escuro para o claro e volta para o mesmo escuro", () => {
    useThemeStore.getState().escolher("meia-noite");

    useThemeStore.getState().alternar();
    expect(document.documentElement.dataset.theme).toBe("papel");

    useThemeStore.getState().alternar();
    expect(document.documentElement.dataset.theme).toBe("meia-noite");
  });

  it("persiste — alternar é escolha do usuário, não estado passageiro", () => {
    useThemeStore.getState().alternar();
    expect(saveThemeMock).toHaveBeenCalled();
  });
});
