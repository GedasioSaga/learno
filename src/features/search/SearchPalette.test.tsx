import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchPalette } from "./SearchPalette";
import { searchPages, type SearchResult } from "../../lib/ipc";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    searchPages: vi.fn(),
  };
});

const searchPagesMock = vi.mocked(searchPages);

function sampleResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    page_id: "11111111-1111-1111-1111-111111111111",
    page_title: "Biologia",
    snippet: "Biologia",
    match_kind: "title",
    rank: 1,
    ...overrides,
  };
}

beforeEach(() => {
  searchPagesMock.mockReset();
});

describe("SearchPalette", () => {
  it("fica fechada até Ctrl/Cmd+K, e Esc fecha de novo (FUN-037)", async () => {
    // Caso e2e-playwright equivalente: abrir o app de verdade, apertar
    // Ctrl+K (ou Cmd+K no macOS) e confirmar que o campo de busca recebe
    // foco visível na janela real; apertar Esc e confirmar que a paleta
    // some da tela renderizada, não só do DOM virtual.
    render(<SearchPalette />);
    expect(screen.queryByRole("dialog", { name: "Busca global" })).not.toBeInTheDocument();

    await userEvent.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Busca global" });
    expect(screen.getByRole("combobox", { name: "Buscar páginas" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
  });

  it("mostra uma dica quando o campo está vazio, sem chamar o backend", async () => {
    render(<SearchPalette />);
    await userEvent.keyboard("{Control>}k{/Control}");

    expect(await screen.findByText("Busque em qualquer página")).toBeInTheDocument();
    expect(searchPagesMock).not.toHaveBeenCalled();
  });

  it("busca ao vivo com debounce e mostra os resultados (FUN-037)", async () => {
    const user = userEvent.setup({ delay: null });
    searchPagesMock.mockResolvedValue([sampleResult()]);

    render(<SearchPalette />);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox", { name: "Buscar páginas" }), "bio");

    expect(await screen.findByText("Biologia")).toBeInTheDocument();
    expect(searchPagesMock).toHaveBeenCalledWith("bio");
  });

  it("seleciona um resultado sem quebrar quando `onNavigate` não foi passado", async () => {
    // Cobre o campo opcional ausente: `onNavigate?` fica de fato ausente aqui
    // (nenhum valor passado), diferente de todo outro teste deste arquivo.
    const user = userEvent.setup({ delay: null });
    searchPagesMock.mockResolvedValue([sampleResult()]);

    render(<SearchPalette />);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox", { name: "Buscar páginas" }), "bio");
    await screen.findByText("Biologia");

    await user.keyboard("{Enter}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("mostra estado de nenhum resultado para um termo sem correspondência", async () => {
    const user = userEvent.setup({ delay: null });
    searchPagesMock.mockResolvedValue([]);

    render(<SearchPalette />);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox", { name: "Buscar páginas" }), "xyznaoexiste");

    expect(await screen.findByText(/Nada encontrado/)).toBeInTheDocument();
  });

  it("mostra um erro do backend sem travar a interface", async () => {
    const user = userEvent.setup({ delay: null });
    searchPagesMock.mockRejectedValue(new Error("banco de dados ainda não conectado"));

    render(<SearchPalette />);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox", { name: "Buscar páginas" }), "bio");

    expect(await screen.findByRole("alert")).toHaveTextContent("banco de dados ainda não conectado");
  });

  it("navega os resultados pelo teclado e confirma com Enter", async () => {
    const user = userEvent.setup({ delay: null });
    const onNavigate = vi.fn();
    searchPagesMock.mockResolvedValue([
      sampleResult({ page_id: "aaaa", page_title: "Biologia" }),
      sampleResult({ page_id: "bbbb", page_title: "Bioquímica" }),
    ]);

    render(<SearchPalette onNavigate={onNavigate} />);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByRole("combobox", { name: "Buscar páginas" }), "bio");
    await screen.findByText("Biologia");

    await user.keyboard("{ArrowDown}{Enter}");

    expect(onNavigate).toHaveBeenCalledWith("bbbb");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
