import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PageRow } from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { Breadcrumb } from "./Breadcrumb";

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

beforeEach(() => {
  usePageTreeStore.setState({
    status: "idle",
    errorMessage: null,
    pagesById: new Map(),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: null,
  });
});

describe("Breadcrumb", () => {
  it("FUN-019: mostra a trilha A / B / C da raiz até a página aberta, direto do store", async () => {
    const a = row({ id: "A", title: "A" });
    const b = row({ id: "B", parent_id: "A", title: "B" });
    const c = row({ id: "C", parent_id: "B", title: "C" });
    usePageTreeStore.setState({
      status: "ready",
      pagesById: new Map([["A", a], ["B", b], ["C", c]]),
    });

    render(<Breadcrumb pageId="C" />);

    const nav = await screen.findByRole("navigation", { name: "Trilha de navegação" });
    expect(nav).toHaveTextContent(/A.*B.*C/);
    // A página atual (C) não é um link — é só o item corrente da trilha.
    expect(screen.getByText(/C/, { selector: "[aria-current='page']" })).toBeInTheDocument();
  });

  it("FUN-019: clicar num ancestral da trilha navega até ele", async () => {
    const user = userEvent.setup();
    const a = row({ id: "A", title: "A" });
    const b = row({ id: "B", parent_id: "A", title: "B" });
    const c = row({ id: "C", parent_id: "B", title: "C" });
    usePageTreeStore.setState({
      status: "ready",
      pagesById: new Map([["A", a], ["B", b], ["C", c]]),
    });

    render(<Breadcrumb pageId="C" />);

    await user.click(await screen.findByRole("button", { name: /B/ }));

    expect(usePageTreeStore.getState().selectedPageId).toBe("B");
  });

  it("FUN-011: o ícone da página aparece na trilha de navegação", async () => {
    const a = row({ id: "A", title: "A", icon: "🧠" });
    const b = row({ id: "B", parent_id: "A", title: "B", icon: "🔬" });
    usePageTreeStore.setState({
      status: "ready",
      pagesById: new Map([["A", a], ["B", b]]),
    });

    render(<Breadcrumb pageId="B" />);

    const nav = await screen.findByRole("navigation", { name: "Trilha de navegação" });
    // O critério de aceite fala do emoji APARECENDO — não só de o backend
    // devolver o campo `icon` (isso já era garantido pelo tipo `PageRow`).
    // Cobre os dois papéis que um item da trilha pode ter: ancestral
    // clicável (A) e item corrente (B, `aria-current="page"`).
    expect(within(nav).getByRole("button", { name: /🧠 A/ })).toBeInTheDocument();
    expect(within(nav).getByText(/🔬 B/, { selector: "[aria-current='page']" })).toBeInTheDocument();
  });

  it("uma página sem título vira 'Sem título' na trilha, nunca um item em branco", async () => {
    usePageTreeStore.setState({
      status: "ready",
      pagesById: new Map([["raiz", row({ id: "raiz", title: "" })]]),
    });

    render(<Breadcrumb pageId="raiz" />);

    expect(await screen.findByText(/Sem título/)).toBeInTheDocument();
  });

  it("a árvore ainda carregando não trava em branco nem em erro — mostra 'Carregando'", () => {
    usePageTreeStore.setState({ status: "loading", pagesById: new Map() });

    render(<Breadcrumb pageId="C" />);

    expect(screen.getByText("Carregando…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("árvore ainda em carregamento, mas a própria página já chegou e o ancestral ainda não — mostra a trilha parcial, sem piscar 'Carregando' nem erro", () => {
    // Caso (a) do briefing, na combinação exata: `status` continua "loading"
    // (a árvore inteira ainda não terminou de chegar) mas a página aberta já
    // está em `pagesById` — só o ancestral dela que falta. Como o único
    // gate de "Carregando…" é `trail.length === 0`, uma trilha parcial não
    // trava atrás da tela de carregamento.
    const c = row({ id: "C", parent_id: "B", title: "C" });
    usePageTreeStore.setState({
      status: "loading",
      pagesById: new Map([["C", c]]),
    });

    render(<Breadcrumb pageId="C" />);

    const nav = screen.getByRole("navigation", { name: "Trilha de navegação" });
    expect(nav).toHaveTextContent(/^📄 C$/);
    expect(screen.queryByText("Carregando…")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uma página que não está (mais) na árvore ativa, com a árvore já carregada, mostra erro em vez de 'Carregando' para sempre", () => {
    usePageTreeStore.setState({ status: "ready", pagesById: new Map() });

    render(<Breadcrumb pageId="fantasma" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível exibir a trilha desta página.");
  });

  it("ancestral excluído (foi para a lixeira, FUN-027/030) não gera erro de parent_id inexistente — a trilha só para de subir ali", () => {
    // "B" não está no mapa (foi trashado); "C" ainda aponta parent_id "B".
    // A subida de C deve parar em C, sem lançar e sem incluir "A" — que só
    // seria alcançável passando por B.
    const a = row({ id: "A", title: "A" });
    const c = row({ id: "C", parent_id: "B", title: "C" });
    usePageTreeStore.setState({
      status: "ready",
      pagesById: new Map([["A", a], ["C", c]]),
    });

    render(<Breadcrumb pageId="C" />);

    const nav = screen.getByRole("navigation", { name: "Trilha de navegação" });
    expect(nav).toHaveTextContent(/^📄 C$/);
    expect(within(nav).queryByText(/A/)).not.toBeInTheDocument();
  });

  it("FUN-045: renomear um ancestral no store atualiza a trilha já montada, sem remontar o componente", () => {
    const a = row({ id: "A", title: "Glossário" });
    const b = row({ id: "B", parent_id: "A", title: "B" });
    const c = row({ id: "C", parent_id: "B", title: "C" });
    usePageTreeStore.setState({
      status: "ready",
      pagesById: new Map([["A", a], ["B", b], ["C", c]]),
    });

    render(<Breadcrumb pageId="C" />);

    const navBefore = screen.getByRole("navigation", { name: "Trilha de navegação" });
    expect(navBefore).toHaveTextContent(/Glossário.*B.*C/);

    act(() => {
      usePageTreeStore.setState((state) => ({
        pagesById: new Map(state.pagesById).set("A", row({ id: "A", title: "Dicionário" })),
      }));
    });

    const navAfter = screen.getByRole("navigation", { name: "Trilha de navegação" });
    // Mesmo nó do DOM — prova que foi um re-render, não um remount (um
    // remount trocaria a instância e, com ela, o elemento).
    expect(navAfter).toBe(navBefore);
    expect(navAfter).toHaveTextContent(/Dicionário.*B.*C/);
    expect(screen.queryByText(/Glossário/)).not.toBeInTheDocument();
  });

  it("ancestral trashado ao vivo (não só ausente desde o mount) encolhe a trilha reativamente, sem erro", () => {
    // Caso (b) do briefing na sua variante reativa: a trilha nasce completa
    // A / B / C e só DEPOIS um ancestral (B) vai para a lixeira enquanto o
    // componente continua montado — diferente do teste acima, que já
    // montava com B ausente. Prova que `useMemo` recalcula ao remover uma
    // entrada do mapa, não só ao editar uma existente.
    const a = row({ id: "A", title: "A" });
    const b = row({ id: "B", parent_id: "A", title: "B" });
    const c = row({ id: "C", parent_id: "B", title: "C" });
    usePageTreeStore.setState({
      status: "ready",
      pagesById: new Map([["A", a], ["B", b], ["C", c]]),
    });

    render(<Breadcrumb pageId="C" />);
    const navBefore = screen.getByRole("navigation", { name: "Trilha de navegação" });
    expect(navBefore).toHaveTextContent(/A.*B.*C/);

    act(() => {
      usePageTreeStore.setState((state) => {
        const next = new Map(state.pagesById);
        next.delete("B");
        return { pagesById: next };
      });
    });

    const navAfter = screen.getByRole("navigation", { name: "Trilha de navegação" });
    expect(navAfter).toBe(navBefore);
    expect(navAfter).toHaveTextContent(/^📄 C$/);
    expect(within(navAfter).queryByText(/A|B/)).not.toBeInTheDocument();
  });

  it("FUN-045: renomear a própria página aberta atualiza o item corrente da trilha ao vivo", () => {
    usePageTreeStore.setState({
      status: "ready",
      pagesById: new Map([["termos", row({ id: "termos", title: "Termos" })]]),
    });

    render(<Breadcrumb pageId="termos" />);
    expect(screen.getByText(/^📄 Termos$/)).toBeInTheDocument();

    act(() => {
      usePageTreeStore.setState((state) => ({
        pagesById: new Map(state.pagesById).set("termos", row({ id: "termos", title: "Termos avançados" })),
      }));
    });

    expect(screen.getByText(/Termos avançados/)).toBeInTheDocument();
    expect(screen.queryByText(/^📄 Termos$/)).not.toBeInTheDocument();
  });
});
