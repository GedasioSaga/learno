import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  applyMindmapChanges,
  createMindmap,
  deleteMindmap,
  getMindmap,
  listMindmaps,
  renameMindmap,
  type MindmapRow,
} from "../../lib/ipc";
import { PainelDeMapaMental } from "./PainelDeMapaMental";
import { useMapaMentalStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listMindmaps: vi.fn(),
    getMindmap: vi.fn(),
    createMindmap: vi.fn(),
    renameMindmap: vi.fn(),
    deleteMindmap: vi.fn(),
    applyMindmapChanges: vi.fn(),
  };
});

const listMindmapsMock = vi.mocked(listMindmaps);
const getMindmapMock = vi.mocked(getMindmap);
const createMindmapMock = vi.mocked(createMindmap);
const renameMindmapMock = vi.mocked(renameMindmap);
const deleteMindmapMock = vi.mocked(deleteMindmap);
const applyMindmapChangesMock = vi.mocked(applyMindmapChanges);

function mapa(overrides: Partial<MindmapRow> & Pick<MindmapRow, "id">): MindmapRow {
  return {
    pageId: null,
    name: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useMapaMentalStore.setState({
    statusLista: "idle",
    mapas: [],
    mapaAtivoId: null,
    statusGrafo: "idle",
    errorMessage: null,
    nos: [],
    arestas: [],
    pendingRenameId: null,
    pendingEditNoId: null,
  });
  getMindmapMock.mockResolvedValue({ mindmap: mapa({ id: "x" }), nodes: [], edges: [] });
  // "+ Novo mapa" (`criarMapa`) já cria o nó raiz do mapa novo — ver item 1
  // do briefing em `store.ts` — então precisa de um retorno aqui mesmo em
  // testes que não estão testando essa parte, senão a chamada real e
  // desmockada de `invoke()` do Tauri rejeitaria (sem runtime Tauri no
  // jsdom) e cada teste de "+ Novo mapa" ficaria mais lento/barulhento à
  // toa por causa de um efeito colateral que não é o que o teste verifica.
  applyMindmapChangesMock.mockResolvedValue({ mindmap: mapa({ id: "x" }), nodes: [], edges: [] });
});

describe("PainelDeMapaMental", () => {
  it("carrega e lista os mapas mentais existentes", async () => {
    listMindmapsMock.mockResolvedValue([mapa({ id: "a", name: "Prova final" }), mapa({ id: "b", name: "TCC" })]);

    render(<PainelDeMapaMental />);

    expect(await screen.findByRole("button", { name: "Prova final" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "TCC" })).toBeInTheDocument();
  });

  it("lista vazia mostra o aviso, não uma lista em branco", async () => {
    listMindmapsMock.mockResolvedValue([]);

    render(<PainelDeMapaMental />);

    expect(await screen.findByText("Nenhum mapa mental ainda.")).toBeInTheDocument();
  });

  it("'+ Novo mapa' cria o mapa e já entra em modo de renomear", async () => {
    const user = userEvent.setup();
    listMindmapsMock.mockResolvedValue([]);
    createMindmapMock.mockResolvedValue(mapa({ id: "novo", name: "Novo mapa" }));

    render(<PainelDeMapaMental />);
    await screen.findByText("Nenhum mapa mental ainda.");

    await user.click(screen.getByRole("button", { name: "Novo mapa" }));

    expect(createMindmapMock).toHaveBeenCalledWith("Novo mapa");
    expect(await screen.findByRole("textbox", { name: "Nome de Novo mapa" })).toBeInTheDocument();
  });

  it("o caso que hoje falha calado: quando criar o mapa devolve erro, a tela MOSTRA o erro", async () => {
    const user = userEvent.setup();
    listMindmapsMock.mockResolvedValue([]);
    createMindmapMock.mockRejectedValue(new Error("disco cheio"));

    render(<PainelDeMapaMental />);
    await screen.findByText("Nenhum mapa mental ainda.");

    await user.click(screen.getByRole("button", { name: "Novo mapa" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível criar o mapa mental.");
  });

  it("duplo clique renomeia; Enter confirma", async () => {
    const user = userEvent.setup();
    listMindmapsMock.mockResolvedValue([mapa({ id: "a", name: "Rascunho" })]);
    renameMindmapMock.mockResolvedValue(mapa({ id: "a", name: "Prova de história" }));

    render(<PainelDeMapaMental />);
    const botao = await screen.findByRole("button", { name: "Rascunho" });

    await user.dblClick(botao);
    const input = screen.getByRole("textbox", { name: "Nome de Rascunho" });
    await user.clear(input);
    await user.type(input, "Prova de história{Enter}");

    expect(renameMindmapMock).toHaveBeenCalledWith("a", "Prova de história");
  });

  it("apagar pede confirmação e, confirmando, chama o backend", async () => {
    const user = userEvent.setup();
    listMindmapsMock.mockResolvedValue([mapa({ id: "a", name: "Descartável" })]);
    deleteMindmapMock.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<PainelDeMapaMental />);
    await screen.findByRole("button", { name: "Descartável" });

    await user.click(screen.getByRole("button", { name: "Apagar Descartável" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteMindmapMock).toHaveBeenCalledWith("a");
    confirmSpy.mockRestore();
  });

  it("apagar cancelado na confirmação não chama o backend", async () => {
    const user = userEvent.setup();
    listMindmapsMock.mockResolvedValue([mapa({ id: "a", name: "Mantido" })]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<PainelDeMapaMental />);
    await screen.findByRole("button", { name: "Mantido" });

    await user.click(screen.getByRole("button", { name: "Apagar Mantido" }));

    expect(deleteMindmapMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("clicar num mapa da lista o seleciona", async () => {
    const user = userEvent.setup();
    listMindmapsMock.mockResolvedValue([mapa({ id: "a", name: "Alfa" })]);

    render(<PainelDeMapaMental />);
    await user.click(await screen.findByRole("button", { name: "Alfa" }));

    expect(getMindmapMock).toHaveBeenCalledWith("a");
    await waitFor(() => expect(useMapaMentalStore.getState().mapaAtivoId).toBe("a"));
  });
});
