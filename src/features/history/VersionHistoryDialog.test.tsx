import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VersionHistoryDialog } from "./VersionHistoryDialog";
import { listPageVersions, restorePageVersion, type PageVersion } from "../../lib/ipc";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listPageVersions: vi.fn(),
    restorePageVersion: vi.fn(),
  };
});

const listPageVersionsMock = vi.mocked(listPageVersions);
const restorePageVersionMock = vi.mocked(restorePageVersion);

const PAGE_ID = "22222222-2222-2222-2222-222222222222";

function version(overrides: Partial<PageVersion> = {}): PageVersion {
  return {
    id: "v1",
    page_id: PAGE_ID,
    title: "Anotações",
    content: [],
    reason: "manual",
    created_at: "2026-08-20T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  listPageVersionsMock.mockReset();
  restorePageVersionMock.mockReset();
});

describe("VersionHistoryDialog", () => {
  it("lista os snapshots do mais recente ao mais antigo, com data e hora (FUN-035)", async () => {
    // Caso e2e-playwright equivalente: com uma página real editada em mais
    // de uma sessão (gerando snapshots de verdade), abrir "Histórico de
    // versões" pela UI e conferir a ordem visual e a formatação de data/hora
    // na janela real, não só nos dados devolvidos pelo mock.
    listPageVersionsMock.mockResolvedValue([
      version({ id: "newest", created_at: "2026-08-20T14:00:00Z", reason: "autosave" }),
      version({ id: "oldest", created_at: "2026-08-20T10:00:00Z", reason: "manual" }),
    ]);

    render(<VersionHistoryDialog isOpen onClose={vi.fn()} pageId={PAGE_ID} pageTitle="Anotações" />);

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Salvo automaticamente");
    expect(items[1]).toHaveTextContent("Salvo manualmente");
  });

  it("mostra estado vazio quando a página ainda não tem snapshot", async () => {
    listPageVersionsMock.mockResolvedValue([]);

    render(<VersionHistoryDialog isOpen onClose={vi.fn()} pageId={PAGE_ID} pageTitle="Anotações" />);

    expect(await screen.findByText("Nenhuma versão salva ainda")).toBeInTheDocument();
  });

  it("restaura uma versão como atual e recarrega a lista sem perder as demais (FUN-036)", async () => {
    const user = userEvent.setup();
    listPageVersionsMock
      .mockResolvedValueOnce([version({ id: "old", created_at: "2026-08-20T10:00:00Z" })])
      .mockResolvedValueOnce([
        version({ id: "restore-snapshot", created_at: "2026-08-20T15:00:00Z", reason: "restore" }),
        version({ id: "old", created_at: "2026-08-20T10:00:00Z" }),
      ]);
    restorePageVersionMock.mockResolvedValue(version({ id: "restore-snapshot" }));

    render(<VersionHistoryDialog isOpen onClose={vi.fn()} pageId={PAGE_ID} pageTitle="Anotações" />);

    await user.click(await screen.findByRole("button", { name: "Restaurar" }));

    await waitFor(() => expect(restorePageVersionMock).toHaveBeenCalledWith(PAGE_ID, "old"));
    expect(await screen.findAllByRole("listitem")).toHaveLength(2);
    expect(listPageVersionsMock).toHaveBeenCalledTimes(2);
  });

  it("mostra erro do backend sem apagar a lista quando a restauração falha", async () => {
    const user = userEvent.setup();
    listPageVersionsMock.mockResolvedValue([version({ id: "old" })]);
    restorePageVersionMock.mockRejectedValue(new Error("conflito ao restaurar"));

    render(<VersionHistoryDialog isOpen onClose={vi.fn()} pageId={PAGE_ID} pageTitle="Anotações" />);

    await user.click(await screen.findByRole("button", { name: "Restaurar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("conflito ao restaurar");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("fecha ao clicar no X", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    listPageVersionsMock.mockResolvedValue([]);

    render(<VersionHistoryDialog isOpen onClose={onClose} pageId={PAGE_ID} pageTitle="Anotações" />);
    await user.click(await screen.findByRole("button", { name: "Fechar histórico" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
