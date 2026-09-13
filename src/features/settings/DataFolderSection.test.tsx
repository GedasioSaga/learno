import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { open } from "@tauri-apps/plugin-dialog";
import { DataFolderSection } from "./DataFolderSection";
import { getAppConfig, saveDataDir } from "../../lib/ipc";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return { ...actual, getAppConfig: vi.fn(), saveDataDir: vi.fn() };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const getAppConfigMock = vi.mocked(getAppConfig);
const saveDataDirMock = vi.mocked(saveDataDir);
const openMock = vi.mocked(open);

const PASTA_NOVA = "C:/Users/alguem/Learno";

beforeEach(() => {
  vi.clearAllMocks();
  getAppConfigMock.mockResolvedValue(null);
  saveDataDirMock.mockResolvedValue({ data_dir: PASTA_NOVA });
  openMock.mockResolvedValue(PASTA_NOVA);
});

describe("DataFolderSection", () => {
  it("mostra que está na pasta padrão do sistema quando nada foi escolhido", async () => {
    render(<DataFolderSection />);

    expect(await screen.findByText(/pasta padrão do sistema/i)).toBeInTheDocument();
  });

  it("mostra a pasta escolhida quando já existe uma salva", async () => {
    getAppConfigMock.mockResolvedValue({ data_dir: "D:/Estudos" });

    render(<DataFolderSection />);

    expect(await screen.findByText("D:/Estudos")).toBeInTheDocument();
  });

  /// O ponto do componente: sem ele, `saveDataDir` (correto e testado no Rust)
  /// não teria nenhum clique que o alcançasse depois que o assistente de
  /// primeira execução foi apagado.
  it("troca a pasta pelo comando de IPC depois da confirmação", async () => {
    const user = userEvent.setup();
    render(<DataFolderSection />);
    await screen.findByText(/pasta padrão do sistema/i);

    await user.click(screen.getByRole("button", { name: /escolher outra pasta/i }));
    await user.click(await screen.findByRole("button", { name: "Trocar" }));

    expect(saveDataDirMock).toHaveBeenCalledWith(PASTA_NOVA);
    expect(await screen.findByText(PASTA_NOVA)).toBeInTheDocument();
  });

  it("não troca nada enquanto a confirmação não é dada", async () => {
    const user = userEvent.setup();
    render(<DataFolderSection />);
    await screen.findByText(/pasta padrão do sistema/i);

    await user.click(screen.getByRole("button", { name: /escolher outra pasta/i }));
    // A confirmação existe porque trocar de pasta move o banco; escolher no
    // diálogo não pode, sozinho, disparar isso.
    expect(saveDataDirMock).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(saveDataDirMock).not.toHaveBeenCalled();
    expect(screen.getByText(/pasta padrão do sistema/i)).toBeInTheDocument();
  });

  it("não chama o backend quando o usuário fecha o diálogo sem escolher", async () => {
    openMock.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<DataFolderSection />);
    await screen.findByText(/pasta padrão do sistema/i);

    await user.click(screen.getByRole("button", { name: /escolher outra pasta/i }));

    expect(saveDataDirMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Trocar" })).not.toBeInTheDocument();
  });

  it("mostra o erro do backend em vez de fingir que trocou", async () => {
    saveDataDirMock.mockRejectedValue(new Error("pasta de dados precisa ser um caminho absoluto"));
    const user = userEvent.setup();
    render(<DataFolderSection />);
    await screen.findByText(/pasta padrão do sistema/i);

    await user.click(screen.getByRole("button", { name: /escolher outra pasta/i }));
    await user.click(await screen.findByRole("button", { name: "Trocar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/caminho absoluto/i);
    expect(screen.getByText(/pasta padrão do sistema/i)).toBeInTheDocument();
  });
});
