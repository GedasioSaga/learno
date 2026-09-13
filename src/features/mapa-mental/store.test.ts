import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMindmapChanges,
  createMindmap,
  deleteMindmap,
  getMindmap,
  listMindmaps,
  renameMindmap,
  type MindmapChange,
  type MindmapEdgeRow,
  type MindmapGraph,
  type MindmapNodeRow,
  type MindmapRow,
} from "../../lib/ipc";
import { useMapaMentalStore, type ArestaDoMapa, type NoDoMapa } from "./store";

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

function linhaDeNo(overrides: Partial<MindmapNodeRow> & Pick<MindmapNodeRow, "id">): MindmapNodeRow {
  return {
    mindmapId: "m1",
    label: "",
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

function linhaDeAresta(overrides: Partial<MindmapEdgeRow> & Pick<MindmapEdgeRow, "id">): MindmapEdgeRow {
  return {
    mindmapId: "m1",
    sourceNodeId: "",
    targetNodeId: "",
    label: null,
    style: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function grafo(nodes: MindmapNodeRow[], edges: MindmapEdgeRow[] = [], id = "m1"): MindmapGraph {
  return { mindmap: mapa({ id }), nodes, edges };
}

function noDoMapa(overrides: Partial<NoDoMapa> & Pick<NoDoMapa, "id">): NoDoMapa {
  return {
    type: "cartaoMental",
    position: { x: 0, y: 0 },
    data: { label: "" },
    ...overrides,
  };
}

function arestaDoMapa(overrides: Partial<ArestaDoMapa> & Pick<ArestaDoMapa, "id">): ArestaDoMapa {
  return { source: "", target: "", ...overrides };
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

describe("carregarMapas", () => {
  it("carrega a lista de mapas", async () => {
    listMindmapsMock.mockResolvedValue([mapa({ id: "a", name: "Prova final" })]);

    await useMapaMentalStore.getState().carregarMapas();

    const state = useMapaMentalStore.getState();
    expect(state.statusLista).toBe("ready");
    expect(state.mapas).toEqual([mapa({ id: "a", name: "Prova final" })]);
  });

  it("erro vira status 'error' com mensagem", async () => {
    listMindmapsMock.mockRejectedValue(new Error("rede caiu"));

    await useMapaMentalStore.getState().carregarMapas();

    const state = useMapaMentalStore.getState();
    expect(state.statusLista).toBe("error");
    expect(state.errorMessage).toBe("Não foi possível carregar os mapas mentais.");
  });
});

describe("selecionarMapa", () => {
  it("carrega o grafo e converte nós/arestas para o formato do canvas", async () => {
    getMindmapMock.mockResolvedValue(
      grafo(
        [linhaDeNo({ id: "n1", label: "Ideia", positionX: 10, positionY: 20 })],
        [linhaDeAresta({ id: "e1", sourceNodeId: "n1", targetNodeId: "n1" })],
      ),
    );

    await useMapaMentalStore.getState().selecionarMapa("m1");

    const state = useMapaMentalStore.getState();
    expect(state.statusGrafo).toBe("ready");
    expect(state.mapaAtivoId).toBe("m1");
    expect(state.nos).toEqual([
      { id: "n1", type: "cartaoMental", position: { x: 10, y: 20 }, data: { label: "Ideia", color: null, image: null } },
    ]);
    expect(state.arestas).toEqual([{ id: "e1", source: "n1", target: "n1", label: undefined }]);
  });

  // Continuação do defeito A depois de um reload: sem isto, uma aresta
  // ligada pela direita voltaria a desenhar pelo handle de cima assim que o
  // mapa fosse recarregado, porque `sourceHandle`/`targetHandle` teriam
  // sumido do lado do canvas (ver `handlesDoEstilo`).
  it("recupera sourceHandle/targetHandle gravados em style (aresta ligada por um lado específico)", async () => {
    getMindmapMock.mockResolvedValue(
      grafo(
        [linhaDeNo({ id: "n1" }), linhaDeNo({ id: "n2" })],
        [
          linhaDeAresta({
            id: "e1",
            sourceNodeId: "n1",
            targetNodeId: "n2",
            style: { sourceHandle: "right", targetHandle: "left" },
          }),
        ],
      ),
    );

    await useMapaMentalStore.getState().selecionarMapa("m1");

    expect(useMapaMentalStore.getState().arestas).toEqual([
      { id: "e1", source: "n1", target: "n2", label: undefined, sourceHandle: "right", targetHandle: "left" },
    ]);
  });

  it("style em formato inesperado (aresta antiga, ou JSON livre de outra origem) não quebra — handles ficam undefined", async () => {
    getMindmapMock.mockResolvedValue(
      grafo(
        [linhaDeNo({ id: "n1" }), linhaDeNo({ id: "n2" })],
        [
          linhaDeAresta({ id: "e1", sourceNodeId: "n1", targetNodeId: "n2", style: { sourceHandle: 42 } }),
          linhaDeAresta({ id: "e2", sourceNodeId: "n1", targetNodeId: "n2", style: "não é um objeto" }),
        ],
      ),
    );

    await useMapaMentalStore.getState().selecionarMapa("m1");

    const arestas = useMapaMentalStore.getState().arestas;
    expect(arestas[0].sourceHandle).toBeUndefined();
    expect(arestas[1].sourceHandle).toBeUndefined();
    expect(arestas[1].targetHandle).toBeUndefined();
  });

  it("erro vira status 'error' sem derrubar a lista de mapas", async () => {
    useMapaMentalStore.setState({ mapas: [mapa({ id: "m1" })], statusLista: "ready" });
    getMindmapMock.mockRejectedValue(new Error("mapa sumiu"));

    await useMapaMentalStore.getState().selecionarMapa("m1");

    const state = useMapaMentalStore.getState();
    expect(state.statusGrafo).toBe("error");
    expect(state.errorMessage).toBe("Não foi possível carregar este mapa mental.");
    expect(state.mapas).toEqual([mapa({ id: "m1" })]);
  });
});

/**
 * O backend ADOTA o id que o cliente manda em `createNode` (ver comentário
 * de `MindmapNodeNovo` em `lib/ipc.ts`) — este mock imita esse contrato em
 * vez de devolver um id fixo, senão os testes de seleção/edição pendente
 * abaixo (que comparam contra o id gerado no cliente) ficariam falso-verdes
 * por sorte de string ou falso-vermelhos por não bater.
 */
function ecoarNoCriado(mindmapId: string, changes: MindmapChange[]): MindmapGraph {
  const criar = changes.find((change): change is Extract<MindmapChange, { kind: "createNode" }> => change.kind === "createNode");
  if (!criar) return grafo([], [], mindmapId);
  const id = criar.node.id ?? "gerado-pelo-servidor";
  return grafo(
    [linhaDeNo({ id, label: criar.node.label ?? "", positionX: criar.node.positionX, positionY: criar.node.positionY })],
    [],
    mindmapId,
  );
}

describe("criarMapa", () => {
  it("acrescenta à lista, marca pendingRenameId e seleciona o mapa novo", async () => {
    const novo = mapa({ id: "novo", name: "Novo mapa" });
    createMindmapMock.mockResolvedValue(novo);
    getMindmapMock.mockResolvedValue(grafo([]));
    applyMindmapChangesMock.mockImplementation((mindmapId, changes) =>
      Promise.resolve(ecoarNoCriado(mindmapId, changes)),
    );

    await useMapaMentalStore.getState().criarMapa("Novo mapa");

    const state = useMapaMentalStore.getState();
    expect(state.mapas).toEqual([novo]);
    expect(state.pendingRenameId).toBe("novo");
    expect(state.mapaAtivoId).toBe("novo");
    expect(getMindmapMock).toHaveBeenCalledWith("novo");
  });

  it("item 1 do briefing: mapa novo já abre com o nó raiz criado, selecionado e pronto pra editar — não é um beco sem saída", async () => {
    const novo = mapa({ id: "novo", name: "Novo mapa" });
    createMindmapMock.mockResolvedValue(novo);
    getMindmapMock.mockResolvedValue(grafo([]));
    applyMindmapChangesMock.mockImplementation((mindmapId, changes) =>
      Promise.resolve(ecoarNoCriado(mindmapId, changes)),
    );

    await useMapaMentalStore.getState().criarMapa("Novo mapa");

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [mindmapId, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(mindmapId).toBe("novo");
    expect(changes).toEqual([
      expect.objectContaining({
        kind: "createNode",
        node: expect.objectContaining({ label: "Novo tópico", color: null }),
      }),
    ]);
    const state = useMapaMentalStore.getState();
    expect(state.nos).toHaveLength(1);
    expect(state.nos[0].selected).toBe(true);
    expect(state.pendingEditNoId).toBe(state.nos[0].id);
  });

  it("erro do backend vira errorMessage e a promise rejeita", async () => {
    createMindmapMock.mockRejectedValue(new Error("nome inválido"));

    await expect(useMapaMentalStore.getState().criarMapa("")).rejects.toThrow();
    expect(useMapaMentalStore.getState().errorMessage).toBe("Não foi possível criar o mapa mental.");
  });
});

describe("renomearMapa", () => {
  it("substitui a linha do mapa pelo retorno do backend", async () => {
    useMapaMentalStore.setState({ mapas: [mapa({ id: "a", name: "A" })] });
    renameMindmapMock.mockResolvedValue(mapa({ id: "a", name: "A renomeado" }));

    await useMapaMentalStore.getState().renomearMapa("a", "A renomeado");

    expect(useMapaMentalStore.getState().mapas).toEqual([mapa({ id: "a", name: "A renomeado" })]);
  });
});

describe("apagarMapa", () => {
  it("some da lista e, se era o ativo, limpa a seleção e o canvas", async () => {
    useMapaMentalStore.setState({
      mapas: [mapa({ id: "alvo" })],
      mapaAtivoId: "alvo",
      statusGrafo: "ready",
      nos: [noDoMapa({ id: "n1" })],
    });
    deleteMindmapMock.mockResolvedValue(undefined);

    await useMapaMentalStore.getState().apagarMapa("alvo");

    const state = useMapaMentalStore.getState();
    expect(state.mapas).toEqual([]);
    expect(state.mapaAtivoId).toBeNull();
    expect(state.nos).toEqual([]);
  });

  it("mapa apagado que não era o ativo não mexe na seleção", async () => {
    useMapaMentalStore.setState({ mapas: [mapa({ id: "outro" })], mapaAtivoId: "mantido" });
    deleteMindmapMock.mockResolvedValue(undefined);

    await useMapaMentalStore.getState().apagarMapa("outro");

    expect(useMapaMentalStore.getState().mapaAtivoId).toBe("mantido");
  });
});

describe("aoMudarNos / aoMudarArestas", () => {
  it("aplica mudanças localmente sem chamar o backend — é o caminho de arrastar em andamento", () => {
    useMapaMentalStore.setState({ nos: [noDoMapa({ id: "n1", position: { x: 0, y: 0 } })] });

    useMapaMentalStore.getState().aoMudarNos([
      { id: "n1", type: "position", position: { x: 50, y: 60 }, dragging: true },
    ]);

    expect(useMapaMentalStore.getState().nos[0].position).toEqual({ x: 50, y: 60 });
    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });
});

describe("criarNo", () => {
  it("adiciona o nó localmente e persiste em uma chamada, reconciliando com o retorno do backend", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1" });
    applyMindmapChangesMock.mockResolvedValue(
      grafo([linhaDeNo({ id: "qualquer-id", label: "Ideia nova", positionX: 5, positionY: 6 })]),
    );

    await useMapaMentalStore.getState().criarNo("Ideia nova", { x: 5, y: 6 });

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [mindmapId, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(mindmapId).toBe("m1");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "createNode",
      node: { label: "Ideia nova", positionX: 5, positionY: 6 },
    });
    expect(useMapaMentalStore.getState().nos).toEqual([
      {
        id: "qualquer-id",
        type: "cartaoMental",
        position: { x: 5, y: 6 },
        data: { label: "Ideia nova", color: null, image: null },
      },
    ]);
  });

  it("sem mapa ativo, não faz nada", async () => {
    await useMapaMentalStore.getState().criarNo("Ideia", { x: 0, y: 0 });

    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
    expect(useMapaMentalStore.getState().nos).toEqual([]);
  });
});

describe("criarFilho (Tab no nó selecionado)", () => {
  it("cria o filho ligado por aresta ao pai, numa chamada só", async () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      nos: [noDoMapa({ id: "pai", position: { x: 100, y: 100 } })],
      arestas: [],
    });
    applyMindmapChangesMock.mockImplementation((mindmapId, changes) => Promise.resolve(ecoarNoCriado(mindmapId, changes)));

    await useMapaMentalStore.getState().criarFilho("pai");

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes).toEqual([
      expect.objectContaining({ kind: "createNode", node: expect.objectContaining({ color: "amber" }) }),
      expect.objectContaining({ kind: "createEdge", edge: expect.objectContaining({ sourceNodeId: "pai" }) }),
    ]);
  });

  it("filho de um pai já colorido HERDA a cor do ramo, em vez de abrir cor nova", async () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      nos: [noDoMapa({ id: "pai", data: { label: "Pai", color: "terracotta" } })],
      arestas: [],
    });
    applyMindmapChangesMock.mockImplementation((mindmapId, changes) => Promise.resolve(ecoarNoCriado(mindmapId, changes)));

    await useMapaMentalStore.getState().criarFilho("pai");

    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes[0]).toMatchObject({ kind: "createNode", node: { color: "terracotta" } });
  });

  it("dois filhos diretos da raiz (sem cor) recebem cores DIFERENTES entre si", async () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      nos: [noDoMapa({ id: "raiz" }), noDoMapa({ id: "filho1" })],
      // A raiz já tem um filho antes desta chamada — é isso que faz a
      // paleta avançar pra próxima cor, não repetir a primeira.
      arestas: [{ id: "e1", source: "raiz", target: "filho1" }],
    });
    applyMindmapChangesMock.mockImplementation((mindmapId, changes) => Promise.resolve(ecoarNoCriado(mindmapId, changes)));

    await useMapaMentalStore.getState().criarFilho("raiz");

    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes[0]).toMatchObject({ kind: "createNode", node: { color: "mint" } });
  });

  it("pai inexistente não faz nada", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1", nos: [], arestas: [] });

    await useMapaMentalStore.getState().criarFilho("nao-existe");

    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });
});

describe("criarIrmao (Enter no nó selecionado)", () => {
  it("cria outro filho do MESMO pai do nó selecionado, não um filho do nó em si", async () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      nos: [noDoMapa({ id: "raiz" }), noDoMapa({ id: "irmao1", data: { label: "Irmão 1", color: "amber" } })],
      arestas: [{ id: "e1", source: "raiz", target: "irmao1" }],
    });
    applyMindmapChangesMock.mockImplementation((mindmapId, changes) => Promise.resolve(ecoarNoCriado(mindmapId, changes)));

    await useMapaMentalStore.getState().criarIrmao("irmao1");

    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes).toEqual([
      // Mesmo pai do nó selecionado ("raiz"), NÃO "irmao1".
      expect.objectContaining({ kind: "createNode", node: expect.objectContaining({ color: "amber" }) }),
      expect.objectContaining({ kind: "createEdge", edge: expect.objectContaining({ sourceNodeId: "raiz" }) }),
    ]);
  });

  it("nó sem pai (raiz/órfão) se comporta como Tab: cria um filho dele mesmo, nunca um no-op", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1", nos: [noDoMapa({ id: "raiz" })], arestas: [] });
    applyMindmapChangesMock.mockImplementation((mindmapId, changes) => Promise.resolve(ecoarNoCriado(mindmapId, changes)));

    await useMapaMentalStore.getState().criarIrmao("raiz");

    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes[1]).toMatchObject({ kind: "createEdge", edge: { sourceNodeId: "raiz" } });
  });
});

describe("renomearNo", () => {
  it("atualiza o texto localmente e persiste em uma chamada", async () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      nos: [noDoMapa({ id: "n1", data: { label: "Antigo", color: null } })],
    });
    applyMindmapChangesMock.mockResolvedValue(grafo([linhaDeNo({ id: "n1", label: "Novo nome" })]));

    await useMapaMentalStore.getState().renomearNo("n1", "Novo nome");

    expect(applyMindmapChangesMock).toHaveBeenCalledWith("m1", [
      { kind: "updateNode", id: "n1", patch: { label: "Novo nome" } },
    ]);
  });

  it("texto vazio (só espaço) não persiste nada", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1", nos: [noDoMapa({ id: "n1" })] });

    await useMapaMentalStore.getState().renomearNo("n1", "   ");

    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });
});

describe("confirmarArrasto", () => {
  it("PONTO 1 do briefing: um arrasto de vários nós vira UMA chamada só, com todos os nós no mesmo lote", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1" });
    applyMindmapChangesMock.mockResolvedValue(grafo([]));

    await useMapaMentalStore.getState().confirmarArrasto([
      noDoMapa({ id: "n1", position: { x: 10, y: 20 } }),
      noDoMapa({ id: "n2", position: { x: 30, y: 40 } }),
    ]);

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes).toEqual([
      { kind: "moveNode", id: "n1", position: { positionX: 10, positionY: 20 } },
      { kind: "moveNode", id: "n2", position: { positionX: 30, positionY: 40 } },
    ]);
  });

  it("lista vazia (nenhum nó de fato movido) não chama o backend", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1" });

    await useMapaMentalStore.getState().confirmarArrasto([]);

    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });
});

describe("conectar", () => {
  it("adiciona a aresta localmente e persiste em uma chamada", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1" });
    applyMindmapChangesMock.mockResolvedValue(
      grafo([], [linhaDeAresta({ id: "qualquer-id", sourceNodeId: "n1", targetNodeId: "n2" })]),
    );

    await useMapaMentalStore
      .getState()
      .conectar({ source: "n1", target: "n2", sourceHandle: null, targetHandle: null });

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes[0]).toMatchObject({ kind: "createEdge", edge: { sourceNodeId: "n1", targetNodeId: "n2" } });
    expect(useMapaMentalStore.getState().arestas).toEqual([
      { id: "qualquer-id", source: "n1", target: "n2", label: undefined },
    ]);
  });

  // Defeito A do relatório do usuário: ligar dois cartões por QUALQUER lado
  // (não só o de cima). O que prova que o defeito está corrigido não é só
  // "a ligação aconteceu" (isso já funcionava antes, só desenhava errado) —
  // é que os IDS DE HANDLE de cada lado (`CartaoNode.tsx`: "top"/"right"/
  // "bottom"/"left") viajam junto até o backend dentro de `edge.style`, pra
  // sobreviver a um reload (`handlesDoEstilo`, no outro sentido).
  it("liga da alça DIREITA de um nó até a alça ESQUERDA de outro e persiste os dois handles em style", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1" });
    applyMindmapChangesMock.mockResolvedValue(
      grafo([], [linhaDeAresta({ id: "qualquer-id", sourceNodeId: "n1", targetNodeId: "n2" })]),
    );

    await useMapaMentalStore
      .getState()
      .conectar({ source: "n1", target: "n2", sourceHandle: "right", targetHandle: "left" });

    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes[0]).toMatchObject({
      kind: "createEdge",
      edge: {
        sourceNodeId: "n1",
        targetNodeId: "n2",
        style: { sourceHandle: "right", targetHandle: "left" },
      },
    });
  });

  it("liga da alça de BAIXO até a alça de CIMA e persiste os dois handles em style", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1" });
    applyMindmapChangesMock.mockResolvedValue(
      grafo([], [linhaDeAresta({ id: "qualquer-id", sourceNodeId: "n1", targetNodeId: "n2" })]),
    );

    await useMapaMentalStore
      .getState()
      .conectar({ source: "n1", target: "n2", sourceHandle: "bottom", targetHandle: "top" });

    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes[0]).toMatchObject({
      kind: "createEdge",
      edge: {
        sourceNodeId: "n1",
        targetNodeId: "n2",
        style: { sourceHandle: "bottom", targetHandle: "top" },
      },
    });
  });

  it("sem handle (connectionMode diferente de loose) não grava lixo em style", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1" });
    applyMindmapChangesMock.mockResolvedValue(
      grafo([], [linhaDeAresta({ id: "qualquer-id", sourceNodeId: "n1", targetNodeId: "n2" })]),
    );

    await useMapaMentalStore
      .getState()
      .conectar({ source: "n1", target: "n2", sourceHandle: null, targetHandle: null });

    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    const change = changes[0];
    // Narrow pelo discriminante `kind` em vez de `as`: é um union type de
    // verdade (`MindmapChange`), e só a variante `createEdge` tem `.edge`.
    if (change.kind !== "createEdge") throw new Error(`esperava "createEdge", recebi "${change.kind}"`);
    // `toEqual` (não `toMatchObject`, que aceitaria QUALQUER `style` aqui
    // por `{}` ser subconjunto de tudo): sem handle nenhum, `style` precisa
    // ser exatamente vazio — nenhum `sourceHandle`/`targetHandle` sobrando.
    expect(change.edge.style).toEqual({});
  });
});

describe("definirImagemDoNo", () => {
  it("grava o arquivo localmente e persiste um patch com a chave image preenchida", async () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      nos: [noDoMapa({ id: "n1", data: { label: "Núcleo", image: null } })],
    });
    applyMindmapChangesMock.mockResolvedValue(grafo([linhaDeNo({ id: "n1", image: "abc123.png" })]));

    await useMapaMentalStore.getState().definirImagemDoNo("n1", "abc123.png");

    expect(applyMindmapChangesMock).toHaveBeenCalledWith("m1", [
      { kind: "updateNode", id: "n1", patch: { image: "abc123.png" } },
    ]);
  });

  // O achado central do defeito B: REMOVER a imagem precisa mandar
  // `image: null` DENTRO do patch — nunca omitir a chave, que o backend leria
  // como "sem mudança" (ver o comentário de `MindmapNodePatch.image`).
  it("remover a imagem manda explicitamente patch: { image: null }, não um patch vazio", async () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      nos: [noDoMapa({ id: "n1", data: { label: "Núcleo", image: "abc123.png" } })],
    });
    applyMindmapChangesMock.mockResolvedValue(grafo([linhaDeNo({ id: "n1", image: null })]));

    await useMapaMentalStore.getState().definirImagemDoNo("n1", null);

    expect(applyMindmapChangesMock).toHaveBeenCalledWith("m1", [
      { kind: "updateNode", id: "n1", patch: { image: null } },
    ]);
  });

  it("nó sem imagem continua igual quando nenhuma ação de imagem é chamada", async () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      nos: [noDoMapa({ id: "n1", data: { label: "Sem foto" } })],
    });

    expect(useMapaMentalStore.getState().nos[0].data.image).toBeUndefined();
    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });

  it("sem mapa ativo, não faz nada", async () => {
    await useMapaMentalStore.getState().definirImagemDoNo("n1", "abc.png");

    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });
});

describe("apagarElementos", () => {
  it("PONTO 1 do briefing: nós e arestas apagados juntos (Delete numa seleção múltipla) viram UMA chamada só", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1" });
    applyMindmapChangesMock.mockResolvedValue(grafo([]));

    await useMapaMentalStore
      .getState()
      .apagarElementos([noDoMapa({ id: "n1" }), noDoMapa({ id: "n2" })], [arestaDoMapa({ id: "e1" })]);

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes).toEqual([
      { kind: "deleteNode", id: "n1" },
      { kind: "deleteNode", id: "n2" },
      { kind: "deleteEdge", id: "e1" },
    ]);
  });

  it("nada para apagar não chama o backend", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1" });

    await useMapaMentalStore.getState().apagarElementos([], []);

    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });
});

describe("falha ao persistir", () => {
  it("marca errorMessage e recarrega o grafo de verdade do backend, descartando a edição otimista", async () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1", nos: [] });
    applyMindmapChangesMock.mockRejectedValue(new Error("disco cheio"));
    getMindmapMock.mockResolvedValue(grafo([linhaDeNo({ id: "servidor", label: "O que o backend realmente tem" })]));

    await useMapaMentalStore.getState().criarNo("Otimista", { x: 0, y: 0 });

    const state = useMapaMentalStore.getState();
    expect(state.errorMessage).toBe("Não foi possível salvar a mudança no mapa mental.");
    expect(state.nos.map((no) => no.id)).toEqual(["servidor"]);
  });

  it("criar mapa que falha no backend também aparece em errorMessage — erro deixa de morrer calado", async () => {
    createMindmapMock.mockRejectedValue(new Error("nome inválido"));

    await expect(useMapaMentalStore.getState().criarMapa("")).rejects.toThrow();

    // O bug original: `errorMessage` era escrito aqui, mas nenhuma tela lia
    // esse campo fora do carregamento inicial da LISTA — a falha nunca
    // aparecia. `PainelDeMapaMental.test.tsx` cobre o "aparece na tela";
    // aqui é só a garantia de que o campo continua sendo escrito.
    expect(useMapaMentalStore.getState().errorMessage).toBe("Não foi possível criar o mapa mental.");
  });
});

describe("organizarLayoutRadial", () => {
  it("recalcula as posições e persiste TODAS num lote só (item 6 do briefing)", async () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      nos: [
        noDoMapa({ id: "raiz", position: { x: 999, y: 999 } }),
        noDoMapa({ id: "filho", position: { x: 999, y: 999 } }),
      ],
      arestas: [{ id: "e1", source: "raiz", target: "filho" }],
    });
    // Ecoa as posições movidas de volta (mesmo raciocínio de `ecoarNoCriado`
    // acima): sem isto, o `grafo([])` fixo substituiria `nos` por uma lista
    // VAZIA no round-trip de sucesso, e a asserção de posição abaixo nunca
    // encontraria o nó "raiz" outra vez.
    applyMindmapChangesMock.mockImplementation((mindmapId, changes) => {
      const nos = changes
        .filter((change): change is Extract<MindmapChange, { kind: "moveNode" }> => change.kind === "moveNode")
        .map((change) =>
          linhaDeNo({ id: change.id, positionX: change.position.positionX, positionY: change.position.positionY }),
        );
      return Promise.resolve(grafo(nos, [], mindmapId));
    });

    await useMapaMentalStore.getState().organizarLayoutRadial();

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [mindmapId, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(mindmapId).toBe("m1");
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ kind: "moveNode", id: "raiz" });
    expect(changes[1]).toMatchObject({ kind: "moveNode", id: "filho" });
    // A raiz nasce no centro (raio 0 na primeira geração) — os dois nós não
    // podem continuar as posições idênticas {999,999} de antes.
    expect(useMapaMentalStore.getState().nos.find((no) => no.id === "raiz")?.position).toEqual({ x: 0, y: 0 });
  });

  it("sem mapa ativo, não faz nada", async () => {
    await useMapaMentalStore.getState().organizarLayoutRadial();

    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });
});
