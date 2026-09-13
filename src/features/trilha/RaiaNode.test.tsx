import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { removerRaia, type RaiaDaTrilha, type Trilha } from "../../lib/ipc";
import { RaiaNode } from "./RaiaNode";
import { useTrilhaStore } from "./store";

/**
 * Mesmo motivo de `EtapaNode.test.tsx`: "Apagar raia" é a superfície mais
 * nova e mais perigosa desta rodada (TRL-014 garante que a raia some sem
 * levar etapa nenhuma junto), e nenhum teste protegia isso até agora — não
 * existia sequer `RaiaNode.test.tsx`.
 */

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    obterTrilha: vi.fn(),
    removerRaia: vi.fn(),
  };
});

const removerRaiaMock = vi.mocked(removerRaia);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

function raiaFixture(overrides: Partial<RaiaDaTrilha> = {}): RaiaDaTrilha {
  return { viewId: "v1", laneValue: "T.I.", position: "a0", isCollapsed: false, createdAt: "", updatedAt: "", ...overrides };
}

function trilhaFixture(raias: RaiaDaTrilha[]): Trilha {
  return {
    configuracao: { viewId: "v1", groupPropertyId: "p1", createdAt: "", updatedAt: "" },
    raias,
    etapas: [],
    flechas: [],
    materiais: [],
    decisoes: [],
  };
}

const nodeTypes = { trilhaRaia: RaiaNode };

/**
 * `nodesDraggable={false}`: diferente de `EtapaNode.test.tsx` (onde toda
 * interação mora no `NodeToolbar`, um portal fora do nó arrastável), aqui o
 * botão de apagar mora no CORPO do nó — clicar nele sem isto dispara o
 * `mousedown` que o `d3-drag` registra no wrapper e quebra no jsdom
 * (`Cannot read properties of null`), mesmo caminho que `TrilhaCanvas.tsx`
 * já desliga em produção.
 */
function renderizarRaia(laneValue: string, dados: { totalEtapas: number; concluidas: number } = { totalEtapas: 0, concluidas: 0 }) {
  const alvo = useTrilhaStore.getState().trilha?.raias.find((r) => r.laneValue === laneValue) ?? raiaFixture({ laneValue });
  return render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow
          nodes={[
            {
              id: `raia-${laneValue}`,
              type: "trilhaRaia" as const,
              position: { x: 0, y: 0 },
              data: { raia: alvo, cor: null, totalEtapas: dados.totalEtapas, concluidas: dados.concluidas },
            },
          ]}
          edges={[]}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        />
      </div>
    </ReactFlowProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useTrilhaStore.setState({
    status: "pronta",
    viewId: "v1",
    trilha: trilhaFixture([raiaFixture()]),
    errorMessage: null,
  });
});

/**
 * O nó inteiro (corpo, fora de qualquer `NodeToolbar`) fica `visibility:
 * hidden` neste arnês até o `ResizeObserver` medi-lo — mockado como no-op —
 * e é isso, não falta de marcação, que faz `getByRole`/`getByLabelText`
 * devolverem lista vazia mesmo com o botão certinho no DOM (`getByRole`
 * exclui elemento inacessível da árvore ARIA; `querySelector` não liga para
 * isso). Por isso as buscas abaixo usam `container.querySelector` — e
 * `userEvent.click` num elemento já resolvido funciona igual, porque o
 * clique em si não recalcula acessibilidade.
 */
function botaoApagar(container: HTMLElement): HTMLElement {
  const botao = container.querySelector('[title="Apagar raia"]');
  if (!(botao instanceof HTMLElement)) throw new Error("botão 'Apagar raia' não encontrado no container");
  return botao;
}

function botaoNoAlertdialog(container: HTMLElement, nome: string): HTMLElement {
  const dialogo = container.querySelector('[role="alertdialog"]');
  if (!(dialogo instanceof HTMLElement)) throw new Error("alertdialog não encontrado no container");
  const botao = [...dialogo.querySelectorAll("button")].find((el) => el.textContent === nome);
  if (!botao) throw new Error(`botão "${nome}" não encontrado dentro do alertdialog`);
  return botao;
}

describe("RaiaNode — apagar raia", () => {
  it("raia com etapas: a confirmação diz quantas vão para 'Sem raia' e que elas não são apagadas", async () => {
    const user = userEvent.setup();
    const { container } = renderizarRaia("T.I.", { totalEtapas: 3, concluidas: 1 });

    await user.click(botaoApagar(container));

    const dialogo = container.querySelector('[role="alertdialog"]');
    expect(dialogo).not.toBeNull();
    expect(dialogo?.getAttribute("aria-label")).toBe("Apagar a raia T.I.?");
    const texto = dialogo?.textContent ?? "";
    expect(texto).toContain("3 etapas");
    expect(texto).toContain("não são apagadas");
  });

  it("raia vazia: confirmação simples, sem contagem", async () => {
    const user = userEvent.setup();
    const { container } = renderizarRaia("T.I.", { totalEtapas: 0, concluidas: 0 });

    await user.click(botaoApagar(container));

    const texto = container.querySelector('[role="alertdialog"]')?.textContent ?? "";
    expect(texto).toContain("está vazia");
  });

  it("confirmar chama removerRaia com viewId e laneValue", async () => {
    const user = userEvent.setup();
    removerRaiaMock.mockResolvedValue(undefined);
    const { container } = renderizarRaia("T.I.", { totalEtapas: 2, concluidas: 0 });

    await user.click(botaoApagar(container));
    await user.click(botaoNoAlertdialog(container, "Apagar mesmo assim"));

    expect(removerRaiaMock).toHaveBeenCalledWith("v1", "T.I.");
  });

  it("cancelar não chama removerRaia e fecha a confirmação", async () => {
    const user = userEvent.setup();
    const { container } = renderizarRaia("T.I.", { totalEtapas: 2, concluidas: 0 });

    await user.click(botaoApagar(container));
    await user.click(botaoNoAlertdialog(container, "Cancelar"));

    expect(removerRaiaMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeInTheDocument();
  });

  it("a raia sintética sem título (TRL-014, sem trail_lanes por trás) não ganha botão de apagar", () => {
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilhaFixture([raiaFixture({ laneValue: "" })]),
      errorMessage: null,
    });
    const { container } = renderizarRaia("", { totalEtapas: 5, concluidas: 0 });

    expect(container.querySelector('[title="Apagar raia"]')).not.toBeInTheDocument();
  });
});
