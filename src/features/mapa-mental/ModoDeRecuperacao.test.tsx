/**
 * Item 1 do briefing desta peça: modo de recuperação ativa. O que mais
 * importa provar aqui, na ordem do próprio briefing:
 * - a estrutura fica visível, só o TEXTO some (e não do raiz);
 * - revelar é por nó — revelar um não revela os outros;
 * - sair devolve o mapa exatamente como estava, sem NENHUMA escrita no
 *   backend por entrar ou sair (é o que faz este ser um modo de LEITURA);
 * - dá para tudo isso sem mouse.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { applyMindmapChanges, createMindmap, deleteMindmap, renameMindmap } from "../../lib/ipc";
import { vi } from "vitest";
import { ConteudoDeMapaMental } from "./ConteudoDeMapaMental";
import { useRecuperacaoStore } from "./recuperacao-store";
import { useMapaMentalStore, type ArestaDoMapa, type NoDoMapa } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    applyMindmapChanges: vi.fn(),
    createMindmap: vi.fn(),
    renameMindmap: vi.fn(),
    deleteMindmap: vi.fn(),
  };
});

/**
 * TODAS as escritas de mapa mental, não só a principal.
 *
 * A versão anterior afirmava apenas que `applyMindmapChanges` não era
 * chamada. Isso prova o funil de mutação de nós e arestas, mas deixava
 * `createMindmap`/`renameMindmap`/`deleteMindmap` fora — hoje inalcançáveis a
 * partir do modo, mas garantidos só por leitura de código, que precisa ser
 * refeita toda vez que alguém mexer no componente. Um teste que lista as
 * escritas não depende de ninguém lembrar.
 */
const ESCRITAS = {
  applyMindmapChanges: vi.mocked(applyMindmapChanges),
  createMindmap: vi.mocked(createMindmap),
  renameMindmap: vi.mocked(renameMindmap),
  deleteMindmap: vi.mocked(deleteMindmap),
};

function esperarNenhumaEscrita() {
  for (const [nome, mock] of Object.entries(ESCRITAS)) {
    expect(mock, `${nome} foi chamada — o modo de recuperação precisa ser só leitura`).not.toHaveBeenCalled();
  }
}

const applyMindmapChangesMock = ESCRITAS.applyMindmapChanges;

/** Mesmo motivo de `ConteudoDeMapaMental.test.tsx`: jsdom não implementa `ResizeObserver`, que o `@xyflow/react` usa sem checar. Escopo só deste arquivo. */
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

function obterCanvas(container: HTMLElement): HTMLElement {
  const canvas = container.querySelector<HTMLElement>(".mapa-mental-canvas");
  if (!canvas) throw new Error("canvas do mapa mental (.mapa-mental-canvas) não renderizou");
  return canvas;
}

/**
 * O botão "Nó oculto..." mora DENTRO do `<div className="react-flow__node">`
 * que o `@xyflow/react` mantém `visibility: hidden` até medir o nó de
 * verdade (o `ResizeObserver` mockado acima nunca chama de volta em jsdom,
 * então o nó nunca "termina" de medir aqui) — o mesmo motivo do comentário
 * de `ResizeObserverMock`. `getByText`/`queryByText` não são afetados (não
 * filtram por visibilidade), mas `getByRole`/`getByLabelText` são: um
 * elemento `visibility: hidden` é INACESSÍVEL para a árvore de
 * acessibilidade, então a consulta por role nunca o acha, mesmo estando no
 * DOM. Consulta direta pelo atributo (mesmo padrão de
 * `container.querySelector('[data-cor="mint"]')` já usado no resto da
 * feature) contorna isso sem mentir sobre o motivo.
 */
function obterBotoesDeRevelar(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[aria-label="Nó oculto. Clique para revelar."]'));
}

const RAIZ: NoDoMapa = { id: "raiz", type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: "Raiz" } };
const FILHO_1: NoDoMapa = {
  id: "filho1",
  type: "cartaoMental",
  position: { x: 200, y: 0 },
  data: { label: "Filho 1", color: "amber" },
};
const FILHO_2: NoDoMapa = {
  id: "filho2",
  type: "cartaoMental",
  position: { x: 200, y: 90 },
  data: { label: "Filho 2", color: "amber" },
};
const ARESTAS: ArestaDoMapa[] = [
  { id: "e1", source: "raiz", target: "filho1" },
  { id: "e2", source: "raiz", target: "filho2" },
];

function montarMapaDeExemplo() {
  useMapaMentalStore.setState({
    mapaAtivoId: "m1",
    statusGrafo: "ready",
    nos: [RAIZ, FILHO_1, FILHO_2],
    arestas: ARESTAS,
  });
  return render(<ConteudoDeMapaMental />);
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
  useRecuperacaoStore.setState({ ativo: false, revelados: new Set(), focoId: null });
});

describe("modo de recuperação", () => {
  it("desligado por padrão: os três cartões mostram o texto normalmente", () => {
    montarMapaDeExemplo();

    expect(screen.getByText("Raiz")).toBeInTheDocument();
    expect(screen.getByText("Filho 1")).toBeInTheDocument();
    expect(screen.getByText("Filho 2")).toBeInTheDocument();
  });

  it("ligar o modo esconde o texto dos filhos mas mantém o raiz legível e a estrutura (3 caixas) de pé", () => {
    const { container } = montarMapaDeExemplo();

    fireEvent.click(screen.getByRole("button", { name: "Modo de recuperação" }));

    expect(screen.getByText("Raiz")).toBeInTheDocument();
    expect(screen.queryByText("Filho 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Filho 2")).not.toBeInTheDocument();
    // Estrutura visível: as 3 caixas continuam no DOM, só o conteúdo de duas
    // delas virou o placeholder oculto.
    expect(container.querySelectorAll(".mapa-mental-no")).toHaveLength(3);
    expect(obterBotoesDeRevelar(container)).toHaveLength(2);
  });

  it("revelar um nó pelo clique NÃO revela o outro", () => {
    const { container } = montarMapaDeExemplo();
    fireEvent.click(screen.getByRole("button", { name: "Modo de recuperação" }));

    fireEvent.click(obterBotoesDeRevelar(container)[0]);

    expect(screen.getByText("Filho 1")).toBeInTheDocument();
    expect(screen.queryByText("Filho 2")).not.toBeInTheDocument();
  });

  it("'Revelar tudo' mostra todos os nós de uma vez, para conferir", () => {
    montarMapaDeExemplo();
    fireEvent.click(screen.getByRole("button", { name: "Modo de recuperação" }));

    fireEvent.click(screen.getByRole("button", { name: "Revelar tudo" }));

    expect(screen.getByText("Raiz")).toBeInTheDocument();
    expect(screen.getByText("Filho 1")).toBeInTheDocument();
    expect(screen.getByText("Filho 2")).toBeInTheDocument();
  });

  it("sair do modo devolve o mapa exatamente como estava: mesma referência de nós e arestas na store", () => {
    const { container } = montarMapaDeExemplo();
    const nosAntes = useMapaMentalStore.getState().nos;
    const arestasAntes = useMapaMentalStore.getState().arestas;

    fireEvent.click(screen.getByRole("button", { name: "Modo de recuperação" }));
    fireEvent.click(obterBotoesDeRevelar(container)[0]);
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));

    // Mesma REFERÊNCIA (não só o mesmo conteúdo): nada no modo de
    // recuperação jamais chama `set` na store do mapa — só na
    // `useRecuperacaoStore`, separada.
    expect(useMapaMentalStore.getState().nos).toBe(nosAntes);
    expect(useMapaMentalStore.getState().arestas).toBe(arestasAntes);
    // E a tela volta a mostrar tudo normalmente.
    expect(screen.getByText("Raiz")).toBeInTheDocument();
    expect(screen.getByText("Filho 1")).toBeInTheDocument();
    expect(screen.getByText("Filho 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Modo de recuperação" })).toBeInTheDocument();
  });

  it("entrar, revelar um nó, revelar tudo e sair do modo NÃO chama nenhuma escrita no backend", () => {
    const { container } = montarMapaDeExemplo();

    fireEvent.click(screen.getByRole("button", { name: "Modo de recuperação" }));
    fireEvent.click(obterBotoesDeRevelar(container)[0]);
    fireEvent.click(screen.getByRole("button", { name: "Revelar tudo" }));
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));

    // A prova de que é modo de LEITURA: NENHUMA das funções de escrita do
    // mapa mental é chamada por nada que aconteceu acima.
    esperarNenhumaEscrita();
  });

  it("teclado: seta para a direita move o cursor para o próximo nó, e Enter revela só ele", () => {
    const { container } = montarMapaDeExemplo();
    fireEvent.click(screen.getByRole("button", { name: "Modo de recuperação" }));
    const canvas = obterCanvas(container);

    // O cursor nasce no raiz (a deixa de contexto); uma seta o move para o
    // próximo nó da lista (Filho 1).
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "Enter" });

    expect(screen.getByText("Filho 1")).toBeInTheDocument();
    expect(screen.queryByText("Filho 2")).not.toBeInTheDocument();
    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });

  it("teclado: o nó sob o cursor carrega data-foco, e ele muda ao navegar", () => {
    const { container } = montarMapaDeExemplo();
    fireEvent.click(screen.getByRole("button", { name: "Modo de recuperação" }));
    const canvas = obterCanvas(container);

    expect(container.querySelector('[data-foco="true"]')?.textContent).toBe("Raiz");

    fireEvent.keyDown(canvas, { key: "ArrowRight" });

    expect(container.querySelectorAll('[data-foco="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-foco="true"]')?.textContent).not.toBe("Raiz");
  });

  it("teclado: Esc sai do modo sem escrever nada", () => {
    const { container } = montarMapaDeExemplo();
    fireEvent.click(screen.getByRole("button", { name: "Modo de recuperação" }));
    const canvas = obterCanvas(container);

    fireEvent.keyDown(canvas, { key: "Escape" });

    expect(screen.getByRole("button", { name: "Modo de recuperação" })).toBeInTheDocument();
    expect(screen.getByText("Filho 1")).toBeInTheDocument();
    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });

  it("dentro do modo, Tab não cria filho (a tecla vira navegação, não escrita)", () => {
    const { container } = montarMapaDeExemplo();
    fireEvent.click(screen.getByRole("button", { name: "Modo de recuperação" }));
    const canvas = obterCanvas(container);

    fireEvent.keyDown(canvas, { key: "Tab" });

    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });
});
