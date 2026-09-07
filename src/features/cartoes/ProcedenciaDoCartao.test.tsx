import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PageRow } from "../../lib/ipc";
import { useNavegacaoStore } from "../navegacao/store";
import { usePageTreeStore } from "../pages/store";
import { lembrarPaginaDoBloco } from "./origem-do-cartao";
import { ProcedenciaDoCartao } from "./ProcedenciaDoCartao";

function pageRow(overrides: Partial<PageRow> & Pick<PageRow, "id">): PageRow {
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

beforeEach(() => {
  localStorage.clear();
  usePageTreeStore.setState({ pagesById: new Map(), selectedPageId: null });
  useNavegacaoStore.setState({ secaoAtiva: "cartoes" });
});

describe("ProcedenciaDoCartao", () => {
  it("com bloco de origem E página conhecida (gravada por CriarCartaoDeOrigem): mostra 'de: <título>' clicável, que navega até a página", async () => {
    const user = userEvent.setup();
    usePageTreeStore.setState({
      pagesById: new Map([["pagina-1", pageRow({ id: "pagina-1", title: "Biologia celular" })]]),
    });
    lembrarPaginaDoBloco("bloco-1", "pagina-1");

    render(<ProcedenciaDoCartao note={{ sourceBlockId: "bloco-1", sourceTextFrozen: "A mitocôndria é..." }} />);

    const link = screen.getByRole("button", { name: "de: Biologia celular" });
    await user.click(link);

    expect(useNavegacaoStore.getState().secaoAtiva).toBe("notas");
    expect(usePageTreeStore.getState().selectedPageId).toBe("pagina-1");
  });

  it("com bloco de origem mas SEM página conhecida (cache não tem essa instalação): cai para o texto congelado, sem link", () => {
    render(<ProcedenciaDoCartao note={{ sourceBlockId: "bloco-desconhecido", sourceTextFrozen: "Trecho congelado" }} />);

    expect(screen.getByText("de: “Trecho congelado”")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("sem bloco de origem (nó de mapa mental, ou bloco apagado - INT-009): só texto, nunca um link para lugar nenhum", () => {
    render(<ProcedenciaDoCartao note={{ sourceBlockId: null, sourceTextFrozen: "Fotossíntese" }} />);

    expect(screen.getByText("de: “Fotossíntese”")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("nota comum, sem origem nenhuma: não mostra nada", () => {
    const { container } = render(<ProcedenciaDoCartao note={{ sourceBlockId: null, sourceTextFrozen: null }} />);

    expect(container).toBeEmptyDOMElement();
  });
});
