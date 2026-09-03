import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecoveryBanner } from "./RecoveryBanner";
import { autosaveClearPending, autosaveListRecoverable, autosaveMergeWithSaved } from "../../lib/ipc";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    autosaveListRecoverable: vi.fn(),
    autosaveMergeWithSaved: vi.fn(),
    autosaveClearPending: vi.fn(),
  };
});

const listMock = vi.mocked(autosaveListRecoverable);
const mergeMock = vi.mocked(autosaveMergeWithSaved);
const clearMock = vi.mocked(autosaveClearPending);

const entry = { page_id: "page-1", title: "Notas de Aula", content: { text: "rascunho" }, captured_at: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  listMock.mockReset();
  mergeMock.mockReset();
  clearMock.mockReset();
  clearMock.mockResolvedValue(undefined);
});

describe("RecoveryBanner", () => {
  it("não renderiza nada quando não há rascunho recuperável", async () => {
    listMock.mockResolvedValue([]);

    const { container } = render(<RecoveryBanner onRestore={vi.fn()} />);

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("mostra o rascunho quando o merge confirma que ele é mais novo que o último save", async () => {
    listMock.mockResolvedValue([entry]);
    mergeMock.mockResolvedValue(entry);

    render(<RecoveryBanner onRestore={vi.fn()} />);

    expect(await screen.findByText("Notas de Aula")).toBeInTheDocument();
    expect(mergeMock).toHaveBeenCalledWith(entry);
  });

  it("não mostra o rascunho quando o merge diz que ele é mais velho que o último save", async () => {
    listMock.mockResolvedValue([entry]);
    mergeMock.mockResolvedValue(null);

    const { container } = render(<RecoveryBanner onRestore={vi.fn()} />);

    await waitFor(() => expect(mergeMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("clicar em Recuperar chama onRestore e descarta o rascunho", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([entry]);
    mergeMock.mockResolvedValue(entry);
    const onRestore = vi.fn();

    render(<RecoveryBanner onRestore={onRestore} />);
    await screen.findByText("Notas de Aula");

    await user.click(screen.getByRole("button", { name: "Recuperar" }));

    expect(onRestore).toHaveBeenCalledWith(entry);
    expect(clearMock).toHaveBeenCalledWith("page-1");
  });

  it("quando onRestore rejeita, o rascunho continua no diário em vez de ser descartado", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([entry]);
    mergeMock.mockResolvedValue(entry);
    const onRestore = vi.fn().mockRejectedValue(new Error("falha ao restaurar"));

    render(<RecoveryBanner onRestore={onRestore} />);
    await screen.findByText("Notas de Aula");

    await user.click(screen.getByRole("button", { name: "Recuperar" }));

    expect(onRestore).toHaveBeenCalledWith(entry);
    // A falha em `onRestore` (ex.: `rename` rejeitando) não pode apagar a
    // única cópia do rascunho não salvo — `dismiss`/`autosaveClearPending`
    // só roda depois que `onRestore` de fato resolve.
    expect(clearMock).not.toHaveBeenCalled();
    expect(screen.getByText("Notas de Aula")).toBeInTheDocument();
  });

  it("clicar em Descartar remove o aviso sem chamar onRestore", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([entry]);
    mergeMock.mockResolvedValue(entry);
    const onRestore = vi.fn();

    render(<RecoveryBanner onRestore={onRestore} />);
    await screen.findByText("Notas de Aula");

    await user.click(screen.getByRole("button", { name: "Descartar" }));

    expect(onRestore).not.toHaveBeenCalled();
    expect(clearMock).toHaveBeenCalledWith("page-1");
    await waitFor(() => expect(screen.queryByText("Notas de Aula")).not.toBeInTheDocument());
  });
});
