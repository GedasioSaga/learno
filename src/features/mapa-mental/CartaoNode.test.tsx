/**
 * Defeito B do relatório do usuário: imagem dentro do cartão de um nó do
 * mapa mental (SimpleMind/Heptabase). Cobre os três casos que o briefing
 * pede: colocar e remover persiste; um nó sem imagem continua igual.
 *
 * Render via `<ConteudoDeMapaMental>` (não `<CartaoNode>` isolado): o
 * componente usa `Handle`/`NodeToolbar` do `@xyflow/react`, que exigem o
 * contexto de um `<ReactFlow>` de verdade por baixo — mesmo padrão de
 * `ConteudoDeMapaMental.test.tsx`/`CriarCartaoDeNo.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { applyMindmapChanges, type MindmapGraph, type MindmapNodeRow } from "../../lib/ipc";
import { ConteudoDeMapaMental } from "./ConteudoDeMapaMental";
import { useMapaMentalStore, type NoDoMapa } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    applyMindmapChanges: vi.fn(),
  };
});

const applyMindmapChangesMock = vi.mocked(applyMindmapChanges);

/** Mesmo motivo de `ConteudoDeMapaMental.test.tsx`: o jsdom deste projeto não implementa `ResizeObserver`, que `@xyflow/react` usa sem checar. Escopo só deste arquivo. */
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

function linhaDeNo(overrides: Partial<MindmapNodeRow> & Pick<MindmapNodeRow, "id">): MindmapNodeRow {
  return {
    mindmapId: "m1",
    label: "Núcleo",
    positionX: 0,
    positionY: 0,
    color: null,
    shape: null,
    icon: null,
    image: null,
    collapsed: false,
    pageRefId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function grafo(nodes: MindmapNodeRow[]): MindmapGraph {
  return {
    mindmap: { id: "m1", pageId: null, name: "Mapa", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    nodes,
    edges: [],
  };
}

function obterInputDeImagem(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("input de arquivo de imagem não renderizou");
  return input;
}

function arquivoDeImagem(nome = "foto.png"): File {
  return new File(["conteúdo"], nome, { type: "image/png" });
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
});

describe("CartaoNode — imagem (defeito B)", () => {
  it("nó sem imagem continua igual: sem <img>, sem botão 'Remover imagem', e mostra 'Adicionar imagem'", () => {
    const no: NoDoMapa = {
      id: "n1",
      type: "cartaoMental",
      position: { x: 0, y: 0 },
      data: { label: "Núcleo" },
      selected: true,
    };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [no], arestas: [] });

    const { container } = render(<ConteudoDeMapaMental />);

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar imagem" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remover imagem" })).not.toBeInTheDocument();
    expect(screen.getByText("Núcleo")).toBeInTheDocument();
  });

  it("escolher um arquivo grava a imagem, persiste um patch com o nome do arquivo, e mostra a miniatura", async () => {
    const no: NoDoMapa = {
      id: "n1",
      type: "cartaoMental",
      position: { x: 0, y: 0 },
      data: { label: "Núcleo" },
      selected: true,
    };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [no], arestas: [] });
    // `mockImplementation`, não `mockResolvedValue` com um valor fixo: a
    // chave que `storeMediaFile` gera é um UUID aleatório
    // ("blob:<uuid>.png"), imprevisível daqui — o mock precisa ECOAR de
    // volta o que o patch de verdade mandou, exatamente como o backend real
    // faria (grava o que recebeu, devolve o grafo com esse mesmo valor).
    applyMindmapChangesMock.mockImplementation(async (_mindmapId, changes) => {
      const change = changes[0];
      const image = change.kind === "updateNode" && "image" in change.patch ? (change.patch.image ?? null) : null;
      return grafo([linhaDeNo({ id: "n1", label: "Núcleo", image })]);
    });

    const { container } = render(<ConteudoDeMapaMental />);
    // `fireEvent`, não `userEvent.upload`: `userEvent` simula a sequência
    // completa de ponteiro (pointerdown/up) e ela bate de frente com o
    // listener de mousedown que o `d3-zoom` do `@xyflow/react` prende no
    // pane (`Cannot read properties of null` em `d3-drag/nodrag.js`, só no
    // jsdom) — mesmo motivo de `CriarCartaoDeNo.test.tsx` usar
    // `fireEvent.click` em vez de `userEvent.click` para botões dentro do
    // canvas. `fireEvent.change` com `target.files` é o jeito padrão do
    // Testing Library de simular "usuário escolheu um arquivo" sem esse
    // caminho de evento.
    fireEvent.change(obterInputDeImagem(container), { target: { files: [arquivoDeImagem()] } });

    await waitFor(() => expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1));
    const [mindmapId, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(mindmapId).toBe("m1");
    // Fora do Tauri (este teste, todo `vitest`), `storeMediaFile` cai no modo
    // em memória (`media-storage.ts`) e devolve uma chave sintética
    // ("blob:<uuid><extensão>", sem o nome original do arquivo) — o que
    // importa aqui é que ELA viaja no patch, nunca um valor inventado à toa.
    expect(changes[0]).toMatchObject({
      kind: "updateNode",
      id: "n1",
      patch: { image: expect.stringMatching(/^blob:.+\.png$/) },
    });

    // `querySelector`, não `getByRole("img")`: o `<img alt="">` é decorativo
    // de propósito (ver o comentário em `CartaoNode.tsx`), e um `alt` vazio
    // tira a imagem da árvore de acessibilidade — não existe role "img" pra
    // consultar aqui. O `src` só precisa ser uma URL de verdade resolvida
    // por `resolveMediaSrc` (`createObjectUrl`, neste ambiente de teste) —
    // não compara com o nome do arquivo original, que a chave persistida
    // (`blob:<uuid><extensão>`) nunca carrega.
    await waitFor(() => {
      const img = container.querySelector("img");
      if (!img) throw new Error("miniatura da imagem não renderizou");
      expect(img.getAttribute("src")).toMatch(/^blob:/);
    });
    expect(await screen.findByRole("button", { name: "Remover imagem" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trocar imagem" })).toBeInTheDocument();
  });

  it("clicar 'Remover imagem' manda patch.image = null e some com a miniatura", async () => {
    const no: NoDoMapa = {
      id: "n1",
      type: "cartaoMental",
      position: { x: 0, y: 0 },
      // `data:` (não uma chave opaca tipo "blob:..."): `resolveMediaSrc`
      // trata `data:`/`https:` como URL EXTERNA (EDT-024) e devolve direto,
      // sem passar pelo mapa em memória de `media-storage.ts` — o que este
      // teste precisa é só de ALGUM valor que resolva pra uma URL de
      // verdade, não de reproduzir o formato exato que `storeMediaFile`
      // geraria (isso já é coberto pelo teste anterior).
      data: { label: "Núcleo", image: "data:image/png;base64,AAAA" },
      selected: true,
    };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [no], arestas: [] });
    applyMindmapChangesMock.mockResolvedValue(grafo([linhaDeNo({ id: "n1", label: "Núcleo", image: null })]));

    const { container } = render(<ConteudoDeMapaMental />);
    await waitFor(() => expect(container.querySelector("img")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Remover imagem" }));

    await waitFor(() => expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1));
    expect(applyMindmapChangesMock).toHaveBeenCalledWith("m1", [
      { kind: "updateNode", id: "n1", patch: { image: null } },
    ]);
    await waitFor(() => expect(container.querySelector("img")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Adicionar imagem" })).toBeInTheDocument();
  });

  it("arquivo que não é imagem é recusado antes de qualquer chamada ao backend, com uma mensagem visível", async () => {
    const no: NoDoMapa = {
      id: "n1",
      type: "cartaoMental",
      position: { x: 0, y: 0 },
      data: { label: "Núcleo" },
      selected: true,
    };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [no], arestas: [] });

    const { container } = render(<ConteudoDeMapaMental />);
    const arquivoInvalido = new File(["x"], "nota.txt", { type: "text/plain" });
    fireEvent.change(obterInputDeImagem(container), { target: { files: [arquivoInvalido] } });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });
});
