import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renamePage, type PageRow } from "../../../lib/ipc";
import { usePageTreeStore } from "../store";
import { usePageTitle } from "./use-page-title";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return { ...actual, renamePage: vi.fn() };
});

const renamePageMock = vi.mocked(renamePage);

function row(overrides: Partial<PageRow> & Pick<PageRow, "id">): PageRow {
  return {
    parent_id: null,
    database_id: null,
    title: "",
    icon: null,
    position: "1",
    is_favorite: false,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function TitleProbe({ pageId }: { pageId: string }) {
  return <span data-testid="title">{usePageTitle(pageId)}</span>;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePageTreeStore.setState({
    pagesById: new Map([["glossario", row({ id: "glossario", title: "Glossário" })]]),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: null,
  });
});

describe("usePageTitle", () => {
  it("FUN-045: renomear a página no store propaga o novo título sem remount do consumidor", async () => {
    render(<TitleProbe pageId="glossario" />);
    expect(screen.getByTestId("title")).toHaveTextContent("Glossário");

    renamePageMock.mockResolvedValue(row({ id: "glossario", title: "Dicionário" }));
    // O mesmo caminho que `TitleField`/`PageWorkspace` disparam de verdade ao
    // confirmar a edição do título - passa pela action da store, não por um
    // `setState` direto, para provar o fluxo real ponta a ponta.
    await act(async () => {
      await usePageTreeStore.getState().rename("glossario", "Dicionário");
    });

    await waitFor(() => expect(screen.getByTestId("title")).toHaveTextContent("Dicionário"));
  });

  it("uma página que a store ainda não carregou cai no rótulo de reserva em vez de quebrar", () => {
    render(<TitleProbe pageId="fantasma" />);
    expect(screen.getByTestId("title")).toHaveTextContent("Sem título");
  });

  it("página com título vazio mostra 'Sem título', igual ao resto da sidebar/breadcrumb (displayTitle)", () => {
    usePageTreeStore.setState({
      pagesById: new Map([["vazia", row({ id: "vazia", title: "" })]]),
    });
    render(<TitleProbe pageId="vazia" />);
    expect(screen.getByTestId("title")).toHaveTextContent("Sem título");
  });
});
