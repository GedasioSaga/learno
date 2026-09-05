/**
 * FUN-045: "renomear propaga em sidebar, breadcrumb e menções". As outras
 * duas metades já têm prova própria em quem as implementa — sidebar em
 * `PageTree.test.tsx` ("renomear por duplo clique... a linha refletir o novo
 * título") e o texto do link em
 * `../../editor/marks/mention-page/mention-page.test.ts` ("renomear a
 * página no store atualiza o chip"). Este arquivo cobre a metade
 * "breadcrumb de uma página filha".
 *
 * Este arquivo já existiu numa forma que provava um *mecanismo* em vez do
 * critério: quando `Breadcrumb.tsx` ainda buscava a trilha uma vez por
 * `pageId` e nunca assinava a store, a metade viva de FUN-045 foi fechada
 * por fora, com um `LiveBreadcrumb` que trocava a `key` do componente para
 * forçá-lo a remontar e refazer a busca. Os testes então afirmavam
 * `getPageBreadcrumb` ter sido chamado duas vezes — isto é, afirmavam o
 * remount, não o que o usuário vê.
 *
 * `Breadcrumb.tsx` passou a derivar a trilha da própria store, e com isso o
 * remount (e a segunda ida ao backend que ele causava) deixou de existir:
 * os testes de mecanismo quebraram enquanto o critério de aceite passou a
 * ser cumprido melhor do que antes. A lição está registrada aqui porque ela
 * vale para o resto do projeto: o que se afirma é o texto que a pessoa lê na
 * tela depois do rename — nenhum teste abaixo sabe se existe backend.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { PageRow } from "../../../lib/ipc";
import { Breadcrumb } from "../Breadcrumb";
import { usePageTreeStore } from "../store";

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

/** Coloca a árvore na store no estado "carregada", que é o que o `Breadcrumb` exige para desenhar em vez de dizer "Carregando…". */
function loadTree(pages: PageRow[]) {
  usePageTreeStore.setState({
    status: "ready",
    pagesById: new Map(pages.map((page) => [page.id, page])),
  });
}

/** Renomeia na store exatamente como `rename()` grava: a `PageRow` atualizada de volta no mesmo mapa. */
function renameInStore(id: string, title: string) {
  act(() => {
    usePageTreeStore.setState((state) => {
      const current = state.pagesById.get(id);
      if (!current) throw new Error(`página ${id} não está na store`);
      return { pagesById: new Map(state.pagesById).set(id, { ...current, title }) };
    });
  });
}

beforeEach(() => {
  usePageTreeStore.setState({
    status: "ready",
    pagesById: new Map(),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: null,
  });
});

describe("FUN-045: breadcrumb de uma página cuja ancestral foi renomeada", () => {
  it("abrir 'Termos' depois que 'Glossário' virou 'Dicionário' já mostra a trilha com o novo nome", () => {
    loadTree([
      row({ id: "dicionario", title: "Dicionário" }),
      row({ id: "termos", parent_id: "dicionario", title: "Termos" }),
    ]);

    render(<Breadcrumb pageId="termos" />);

    const nav = screen.getByRole("navigation", { name: "Trilha de navegação" });
    expect(nav).toHaveTextContent(/Dicionário.*Termos/);
  });

  it("uma trilha já montada mostra o novo nome do ancestral assim que a store renomeia, sem esperar reabrir a página", () => {
    loadTree([
      row({ id: "dicionario", title: "Glossário" }),
      row({ id: "termos", parent_id: "dicionario", title: "Termos" }),
    ]);

    render(<Breadcrumb pageId="termos" />);
    expect(screen.getByText(/Glossário/)).toBeInTheDocument();

    // A renomeação acontece em outro lugar do app enquanto esta trilha
    // continua montada com o mesmo `pageId` — o caso que o critério chama de
    // "imediatamente".
    renameInStore("dicionario", "Dicionário");

    expect(screen.getByText(/Dicionário/)).toBeInTheDocument();
    expect(screen.queryByText(/Glossário/)).not.toBeInTheDocument();
  });

  it("renomear a própria página aberta também atualiza o item atual da trilha ao vivo", () => {
    loadTree([row({ id: "termos", title: "Termos" })]);

    render(<Breadcrumb pageId="termos" />);
    expect(screen.getByText(/^📄 Termos$/)).toBeInTheDocument();

    renameInStore("termos", "Termos avançados");

    expect(screen.getByText(/Termos avançados/)).toBeInTheDocument();
  });

  it("renomear um ancestral distante propaga por toda a cadeia, não só pelo pai direto", () => {
    loadTree([
      row({ id: "a", title: "Biologia" }),
      row({ id: "b", parent_id: "a", title: "Celular" }),
      row({ id: "c", parent_id: "b", title: "Mitose" }),
    ]);

    render(<Breadcrumb pageId="c" />);
    const nav = screen.getByRole("navigation", { name: "Trilha de navegação" });
    expect(nav).toHaveTextContent(/Biologia.*Celular.*Mitose/);

    renameInStore("a", "Biologia Celular I");

    expect(nav).toHaveTextContent(/Biologia Celular I.*Celular.*Mitose/);
  });
});
