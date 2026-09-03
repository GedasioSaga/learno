import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportMarkdownButton } from "./ExportMarkdownButton";
import { defaultExportFileName, exportPageMarkdown } from "../../lib/ipc";
import { save } from "@tauri-apps/plugin-dialog";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    defaultExportFileName: vi.fn(),
    exportPageMarkdown: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

const defaultExportFileNameMock = vi.mocked(defaultExportFileName);
const exportPageMarkdownMock = vi.mocked(exportPageMarkdown);
const saveMock = vi.mocked(save);

beforeEach(() => {
  defaultExportFileNameMock.mockReset();
  exportPageMarkdownMock.mockReset();
  saveMock.mockReset();
});

describe("ExportMarkdownButton", () => {
  it("exporta a página no caminho escolhido, sugerindo um nome de arquivo saneado", async () => {
    const user = userEvent.setup();
    defaultExportFileNameMock.mockResolvedValue("Aula_ 1.md");
    saveMock.mockResolvedValue("C:/Notas/Aula 1.md");
    exportPageMarkdownMock.mockResolvedValue(undefined);

    render(<ExportMarkdownButton pageId="page-1" pageTitle="Aula: 1" />);

    await user.click(screen.getByRole("button", { name: "Exportar como Markdown" }));

    expect(defaultExportFileNameMock).toHaveBeenCalledWith("Aula: 1");
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Aula_ 1.md" }),
    );
    expect(exportPageMarkdownMock).toHaveBeenCalledWith("page-1", "C:/Notas/Aula 1.md");
    expect(await screen.findByText("Página exportada.")).toBeInTheDocument();
  });

  it("não exporta nada quando o usuário fecha o diálogo sem escolher um arquivo", async () => {
    const user = userEvent.setup();
    defaultExportFileNameMock.mockResolvedValue("Aula 1.md");
    saveMock.mockResolvedValue(null);

    render(<ExportMarkdownButton pageId="page-1" pageTitle="Aula 1" />);

    await user.click(screen.getByRole("button", { name: "Exportar como Markdown" }));

    expect(exportPageMarkdownMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Página exportada.")).not.toBeInTheDocument();
  });

  it("mostra o erro do backend quando a exportação falha", async () => {
    const user = userEvent.setup();
    defaultExportFileNameMock.mockResolvedValue("Aula 1.md");
    saveMock.mockResolvedValue("C:/Notas/Aula 1.md");
    exportPageMarkdownMock.mockRejectedValue(new Error("banco de dados ainda não conectado"));

    render(<ExportMarkdownButton pageId="page-1" pageTitle="Aula 1" />);

    await user.click(screen.getByRole("button", { name: "Exportar como Markdown" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("banco de dados ainda não conectado");
  });
});
