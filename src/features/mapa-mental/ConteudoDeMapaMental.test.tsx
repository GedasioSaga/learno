import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applyMindmapChanges, type MindmapGraph } from "../../lib/ipc";
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

/**
 * O `@xyflow/react` mede o próprio contêiner com `ResizeObserver` (ver
 * `node_modules/@xyflow/react/dist/esm/index.js`, `useResizeHandler`) sem
 * checar se ele existe — e o jsdom deste projeto não o implementa. Sem isto,
 * todo `render()` de `<ReactFlow>` lança `ResizeObserver is not defined`.
 * Escopo só deste arquivo de teste, de propósito: não mexe no
 * `src/test/setup.ts` compartilhado.
 *
 * `instances`/`flush` são usados só pelo bloco "conexão real pelo motor do
 * @xyflow/react" abaixo: o `@xyflow/react` só descobre a posição de cada
 * handle relendo `getBoundingClientRect()` dos elementos DENTRO do callback
 * de um `ResizeObserver` de verdade (ver `getHandleBounds` em
 * `@xyflow/system`) — sem isso, `handleBounds` nunca é preenchido e o motor
 * de conexão nunca decide "qual handle está sob o cursor". Como o jsdom não
 * dispara `ResizeObserver` sozinho, `flush()` deixa o teste disparar esse
 * callback à mão, DEPOIS de forjar `getBoundingClientRect`/`offsetWidth`/
 * `offsetHeight` nos elementos (mesma técnica de
 * `use-posicao-ancorada.test.ts`). Os outros 12 testes deste arquivo nunca
 * chamam `flush()`, então continuam exatamente como antes (nenhum callback
 * dispara sozinho).
 */
class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  private targets = new Set<Element>();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }

  flush() {
    if (this.targets.size === 0) return;
    // `contentRect` também é lido de verdade (`XYPanZoom`'s
    // `extentResizeObserver`, em `@xyflow/system`, além do próprio nó) —
    // aproximado por `getBoundingClientRect()` (sem padding/borda no jsdom,
    // então os dois coincidem).
    const entries = Array.from(this.targets).map(
      (target) => ({ target, contentRect: target.getBoundingClientRect() }) as ResizeObserverEntry,
    );
    this.callback(entries, this as unknown as ResizeObserver);
  }
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

/**
 * `updateNodeInternals` (`@xyflow/system`) lê o zoom atual com
 * `new window.DOMMatrixReadOnly(style.transform).m22` — e o jsdom deste
 * projeto não implementa `DOMMatrixReadOnly` (só existe em navegador de
 * verdade). Sem isto, disparar o `ResizeObserver` mockado (única forma de
 * preencher `handleBounds`, ver o comentário da classe acima) lança
 * `TypeError: window.DOMMatrixReadOnly is not a constructor`. O polyfill só
 * entende o formato que o PRÓPRIO `@xyflow/react` gera
 * (`toTransformString`: `translate(Xpx,Ypx) scale(Z)`) — não é um
 * `DOMMatrix` de verdade, só o suficiente pra `m22` (o fator de escala) sair
 * certo.
 */
if (typeof DOMMatrixReadOnly === "undefined") {
  class DOMMatrixReadOnlyPolyfill {
    m22: number;
    constructor(transform?: string) {
      const escala = /scale\(([-\d.]+)\)/.exec(transform ?? "");
      this.m22 = escala ? Number(escala[1]) : 1;
    }
  }
  vi.stubGlobal("DOMMatrixReadOnly", DOMMatrixReadOnlyPolyfill);
}

/** Dispara todo `ResizeObserver` (mockado) vivo no momento — ver o comentário
 *  da classe acima. Embrulhado em `act` porque o callback mexe no store
 *  interno do `@xyflow/react`, que dispara re-render. */
function flushObservadoresDeRedimensionamento() {
  act(() => {
    ResizeObserverMock.instances.forEach((instancia) => instancia.flush());
  });
}

/**
 * `fireEvent.mouseDown` do testing-library constrói o evento via
 * `node.ownerDocument.defaultView.MouseEvent` (`getWindowFromNode`, em
 * `@testing-library/dom/helpers.js`) e só ACEITA um `view` que seja
 * `instanceof` a MESMA `Window` — passar `window`/`document.defaultView`
 * pelas opções do `fireEvent` falha com
 * `TypeError: Failed to construct 'MouseEvent': member view is not of type Window`
 * neste projeto (Vitest + jsdom): o `view` das opções não é o mesmo objeto
 * que o `fireEvent` interno resolveria sozinho. `useDrag`
 * (`@xyflow/react`) usa `d3-drag`, que LÊ `event.view.document` em
 * `nodrag()` pra desligar seleção de texto durante o arrasto — sem um
 * `view` de verdade, todo `mousedown` de arrasto quebra. Contornado
 * construindo o `MouseEvent` nós mesmos com o construtor e o `view` da
 * MESMA janela (`document.defaultView`), sem passar pelo `fireEvent`.
 */
function dispararMouse(alvo: EventTarget, tipo: "mousedown" | "mousemove" | "mouseup", init: MouseEventInit) {
  const janela = document.defaultView;
  if (!janela) throw new Error("document.defaultView ausente — jsdom não expôs a window");
  // NÃO passar `view` no construtor: o webidl do jsdom exige que `view` seja
  // um `WindowProxy` de verdade (uma checagem interna que nem
  // `document.defaultView` satisfaz neste ambiente Vitest+jsdom — falha com
  // `TypeError: member view is not of type Window` mesmo passando a MESMA
  // janela). `view` default fica `null` sem essa opção. Sobrescrito por
  // `defineProperty` DEPOIS de construído, onde não há validação nenhuma —
  // é só o que `nodrag()` do `d3-drag` precisa (`event.view.document`).
  const evento = new janela.MouseEvent(tipo, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(evento, "view", { value: janela, configurable: true });
  act(() => {
    alvo.dispatchEvent(evento);
  });
}

interface RetanguloForjado {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Mesma técnica de `use-posicao-ancorada.test.ts`: o jsdom não faz layout
 *  nenhum, então `getBoundingClientRect` sempre volta zerado — é preciso
 *  forjar o retângulo pra afirmar qualquer coisa sobre posição/distância. */
function forjarRetangulo(elemento: Element, retangulo: RetanguloForjado) {
  (elemento as HTMLElement).getBoundingClientRect = () =>
    ({
      top: retangulo.top,
      left: retangulo.left,
      width: retangulo.width,
      height: retangulo.height,
      right: retangulo.left + retangulo.width,
      bottom: retangulo.top + retangulo.height,
      x: retangulo.left,
      y: retangulo.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * Forja o nó inteiro (retângulo + `offsetWidth`/`offsetHeight`, que é o que
 * `getDimensions` do `@xyflow/system` lê pra decidir se o nó tem tamanho) e
 * as quatro alças dentro dele, nas quatro bordas do retângulo forjado — é
 * assim que `getHandleBounds` calcula a posição de cada alça RELATIVA ao nó
 * (`(handleBounds.left - nodeBounds.left) / zoom`, ver `@xyflow/system`).
 */
function forjarCartao(container: HTMLElement, id: string, retangulo: RetanguloForjado): HTMLElement {
  const no = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!no) throw new Error(`nó "${id}" (.react-flow__node) não renderizou`);

  forjarRetangulo(no, retangulo);
  Object.defineProperty(no, "offsetWidth", { value: retangulo.width, configurable: true });
  Object.defineProperty(no, "offsetHeight", { value: retangulo.height, configurable: true });

  const posicaoDasAlcas: Record<"top" | "right" | "bottom" | "left", { left: number; top: number }> = {
    top: { left: retangulo.left + retangulo.width / 2, top: retangulo.top },
    right: { left: retangulo.left + retangulo.width, top: retangulo.top + retangulo.height / 2 },
    bottom: { left: retangulo.left + retangulo.width / 2, top: retangulo.top + retangulo.height },
    left: { left: retangulo.left, top: retangulo.top + retangulo.height / 2 },
  };
  for (const [handleId, posicao] of Object.entries(posicaoDasAlcas)) {
    const alca = no.querySelector<HTMLElement>(`[data-handleid="${handleId}"]`);
    if (!alca) throw new Error(`alça "${handleId}" do nó "${id}" não renderizou`);
    forjarRetangulo(alca, { ...posicao, width: 0, height: 0 });
  }

  return no;
}

/**
 * Lê o `translate`/`scale` que o `@xyflow/react` aplicou de verdade no
 * viewport (via `fitView`, prop fixa em `ConteudoDeMapaMental.tsx`) — em vez
 * de assumir identidade, que só valeria por acaso. É o que permite converter
 * uma posição de handle em COORDENADAS DE TELA (`clientX`/`clientY`) pro
 * evento sintético: o motor de conexão faz o caminho inverso
 * (`pointToRendererPoint`) pra decidir qual handle está sob o cursor.
 */
function lerTransformDoViewport(container: HTMLElement): { translateX: number; translateY: number; scale: number } {
  const viewport = container.querySelector<HTMLElement>(".react-flow__viewport");
  if (!viewport) throw new Error(".react-flow__viewport não renderizou");
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(viewport.style.transform);
  if (!match) throw new Error(`não consegui ler translate/scale de "${viewport.style.transform}"`);
  return { translateX: Number(match[1]), translateY: Number(match[2]), scale: Number(match[3]) };
}

function grafoVazio(id: string): MindmapGraph {
  return {
    mindmap: { id, pageId: null, name: "Mapa", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    nodes: [],
    edges: [],
  };
}

/**
 * `querySelector` devolve `Element | null` — em vez de `!` (proibido sem
 * justificar por linha, regra do projeto), falha o teste com uma mensagem
 * clara se o canvas não renderizou, em vez de silenciar o tipo.
 */
function obterCanvas(container: HTMLElement): HTMLElement {
  const canvas = container.querySelector<HTMLElement>(".mapa-mental-canvas");
  if (!canvas) throw new Error("canvas do mapa mental (.mapa-mental-canvas) não renderizou");
  return canvas;
}

beforeEach(() => {
  vi.clearAllMocks();
  ResizeObserverMock.instances = [];
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

describe("ConteudoDeMapaMental", () => {
  it("sem mapa selecionado, mostra o estado vazio em vez do canvas", () => {
    render(<ConteudoDeMapaMental />);

    expect(screen.getByText("Nenhum mapa mental aberto")).toBeInTheDocument();
  });

  it("mapa carregando mostra o aviso de carregamento", () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "loading" });

    render(<ConteudoDeMapaMental />);

    expect(screen.getByText("Carregando mapa mental…")).toBeInTheDocument();
  });

  it("mapa com erro mostra a mensagem em role=alert", () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      statusGrafo: "error",
      errorMessage: "Não foi possível carregar este mapa mental.",
    });

    render(<ConteudoDeMapaMental />);

    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar este mapa mental.");
  });

  it("mapa pronto renderiza o canvas temático (a classe que `mapa-mental.css` sobrescreve) com os cartões existentes", () => {
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      statusGrafo: "ready",
      nos: [{ id: "n1", type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: "Fotossíntese" } }],
      arestas: [],
    });

    const { container } = render(<ConteudoDeMapaMental />);

    expect(container.querySelector(".mapa-mental-canvas")).toBeInTheDocument();
    expect(screen.getByText("Fotossíntese")).toBeInTheDocument();
  });

  it("criar um cartão pelo formulário do painel persiste em UMA chamada com o texto digitado", async () => {
    const user = userEvent.setup();
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [], arestas: [] });
    applyMindmapChangesMock.mockResolvedValue(grafoVazio("m1"));

    render(<ConteudoDeMapaMental />);

    await user.type(screen.getByLabelText("Texto do novo cartão"), "Ciclo da água");
    await user.click(screen.getByRole("button", { name: "+ Cartão" }));

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [mindmapId, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(mindmapId).toBe("m1");
    expect(changes[0]).toMatchObject({ kind: "createNode", node: { label: "Ciclo da água" } });
  });

  it("botão de criar cartão começa desabilitado com o texto vazio", () => {
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [], arestas: [] });

    render(<ConteudoDeMapaMental />);

    expect(screen.getByRole("button", { name: "+ Cartão" })).toBeDisabled();
  });

  it("quando uma mutação falha (ex.: criar cartão), a tela MOSTRA o erro em vez de engolir calado", async () => {
    const user = userEvent.setup();
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [], arestas: [] });
    applyMindmapChangesMock.mockRejectedValue(new Error("disco cheio"));

    render(<ConteudoDeMapaMental />);
    await user.type(screen.getByLabelText("Texto do novo cartão"), "Ciclo da água");
    await user.click(screen.getByRole("button", { name: "+ Cartão" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar a mudança no mapa mental.");
  });

  it("PONTO 2 do briefing: Tab no nó selecionado cria um filho, ligado por aresta", async () => {
    const raiz: NoDoMapa = { id: "raiz", type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: "Raiz" }, selected: true };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [raiz], arestas: [] });
    applyMindmapChangesMock.mockResolvedValue(grafoVazio("m1"));

    const { container } = render(<ConteudoDeMapaMental />);
    fireEvent.keyDown(obterCanvas(container), { key: "Tab" });

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [mindmapId, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(mindmapId).toBe("m1");
    expect(changes).toEqual([
      expect.objectContaining({ kind: "createNode" }),
      expect.objectContaining({ kind: "createEdge", edge: expect.objectContaining({ sourceNodeId: "raiz" }) }),
    ]);
  });

  it("PONTO 2 do briefing: Enter no nó selecionado cria um irmão, ligado ao MESMO pai", async () => {
    const raiz: NoDoMapa = { id: "raiz", type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: "Raiz" } };
    const filho: NoDoMapa = {
      id: "filho",
      type: "cartaoMental",
      position: { x: 200, y: 0 },
      data: { label: "Filho", color: "amber" },
      selected: true,
    };
    useMapaMentalStore.setState({
      mapaAtivoId: "m1",
      statusGrafo: "ready",
      nos: [raiz, filho],
      arestas: [{ id: "e1", source: "raiz", target: "filho" }],
    });
    applyMindmapChangesMock.mockResolvedValue(grafoVazio("m1"));

    const { container } = render(<ConteudoDeMapaMental />);
    fireEvent.keyDown(obterCanvas(container), { key: "Enter" });

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(changes[1]).toMatchObject({ kind: "createEdge", edge: { sourceNodeId: "raiz" } });
  });

  it("sem nenhum nó selecionado, Tab/Enter não fazem nada", async () => {
    const raiz: NoDoMapa = { id: "raiz", type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: "Raiz" } };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [raiz], arestas: [] });

    const { container } = render(<ConteudoDeMapaMental />);
    const canvas = obterCanvas(container);
    fireEvent.keyDown(canvas, { key: "Tab" });
    fireEvent.keyDown(canvas, { key: "Enter" });

    expect(applyMindmapChangesMock).not.toHaveBeenCalled();
  });

  it("um nó com cor de ramo mostra o atributo que `mapa-mental.css` usa pra colorir a borda", () => {
    const filho: NoDoMapa = {
      id: "n1",
      type: "cartaoMental",
      position: { x: 0, y: 0 },
      data: { label: "Fotossíntese", color: "mint" },
    };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [filho], arestas: [] });

    const { container } = render(<ConteudoDeMapaMental />);

    expect(container.querySelector('[data-cor="mint"]')).toBeInTheDocument();
  });

  it("clicar 'Organizar' recalcula o layout radial e persiste as posições", async () => {
    const user = userEvent.setup();
    const raiz: NoDoMapa = { id: "raiz", type: "cartaoMental", position: { x: 999, y: 999 }, data: { label: "Raiz" } };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [raiz], arestas: [] });
    applyMindmapChangesMock.mockResolvedValue(grafoVazio("m1"));

    render(<ConteudoDeMapaMental />);
    await user.click(screen.getByRole("button", { name: "Organizar" }));

    expect(applyMindmapChangesMock).toHaveBeenCalledTimes(1);
    const [mindmapId, changes] = applyMindmapChangesMock.mock.calls[0];
    expect(mindmapId).toBe("m1");
    expect(changes).toEqual([expect.objectContaining({ kind: "moveNode", id: "raiz" })]);
  });
});

/**
 * Fecha o segundo buraco do relatório do revisor cego: a conclusão de que os
 * quatro `<Handle>` (ver `CartaoNode.tsx:272-275`) não roubam a área de
 * clique/arrasto do CORPO do cartão vinha só de ler CSS (`nodrag` nos campos
 * de edição, handles pequenos nas bordas) — nunca de rodar o motor de
 * seleção/arrasto de verdade. Aqui os dois eventos (`click`, `mousedown` →
 * `mousemove` → `mouseup`) disparam no `<p>` do RÓTULO — fora de qualquer
 * `<Handle>` — e a afirmação é sobre o ESTADO que o `@xyflow/react` escreveu
 * de volta no store (`selected`, `position`), não sobre ter sido "chamado".
 */
describe("o corpo do cartão continua clicável/arrastável com os 4 handles presentes", () => {
  it("clicar no corpo do cartão seleciona o nó (motor real de seleção do @xyflow/react)", () => {
    const raiz: NoDoMapa = { id: "raiz", type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: "Raiz" } };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [raiz], arestas: [] });

    render(<ConteudoDeMapaMental />);
    expect(useMapaMentalStore.getState().nos.find((no) => no.id === "raiz")?.selected).not.toBe(true);

    // O rótulo (`<p className="break-words">`) é o corpo do cartão fora de
    // qualquer `<Handle>` — nenhum seletor manual, é o mesmo texto visível
    // que o usuário clica.
    fireEvent.click(screen.getByText("Raiz"));

    expect(useMapaMentalStore.getState().nos.find((no) => no.id === "raiz")?.selected).toBe(true);
  });

  it("arrastar o corpo do cartão move o nó (motor real de drag do @xyflow/react)", () => {
    const raiz: NoDoMapa = { id: "raiz", type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: "Raiz" } };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [raiz], arestas: [] });

    render(<ConteudoDeMapaMental />);
    const corpo = screen.getByText("Raiz");

    // `mousemove`/`mouseup` disparam na PRÓPRIA `window` (não em `document`):
    // é onde o `d3-drag` registra os listeners (`select(event.view)` dentro
    // de `mousedowned`, em `d3-drag/src/drag.js`) — o mesmo `event.view` que
    // `dispararMouse` grava no `mousedown` acima.
    const janela = document.defaultView;
    if (!janela) throw new Error("document.defaultView ausente — jsdom não expôs a window");
    // Duas `mousemove`: a PRIMEIRA só passa do limiar de arrasto
    // (`nodeDragThreshold`, padrão 1px do `@xyflow/react`) — o próprio
    // `XYDrag` "ancora" o nó nessa posição exata pra iniciar o gesto, sem
    // mexer o nó ainda (senão o clique junto com um tremor de 1px já
    // arrastaria). É a SEGUNDA que produz deslocamento de verdade.
    dispararMouse(corpo, "mousedown", { clientX: 100, clientY: 100 });
    dispararMouse(janela, "mousemove", { clientX: 160, clientY: 145 });
    dispararMouse(janela, "mousemove", { clientX: 220, clientY: 190 });
    dispararMouse(janela, "mouseup", { clientX: 220, clientY: 190 });

    const posicaoFinal = useMapaMentalStore.getState().nos.find((no) => no.id === "raiz")?.position;
    // Não afirma um delta exato em px (a escala do viewport depende do
    // `fitView` da própria lib, que este teste não controla) — só que o
    // motor de arrasto de verdade moveu o nó NA DIREÇÃO do gesto a partir
    // do corpo (baixo e pra direita, como o `mousemove` disparado).
    expect(posicaoFinal).toBeDefined();
    expect(posicaoFinal?.x).toBeGreaterThan(0);
    expect(posicaoFinal?.y).toBeGreaterThan(0);
  });
});

/**
 * Fecha o primeiro buraco do relatório do revisor cego: até aqui, todo teste
 * de conexão (`store.test.ts:529-569`) chamava `conectar({...})` com um
 * `Connection` fabricado à mão — nunca um arrasto de handle a handle pelos
 * elementos `<Handle>` do DOM, através do motor de verdade do
 * `@xyflow/react` (`XYHandle.onPointerDown`/`isValidHandle`, em
 * `@xyflow/system`). Aqui o gesto é real: `mousedown` na alça "right" do
 * primeiro cartão, `mousemove` até a alça "left" do segundo, `mouseup` — e a
 * afirmação é sobre os ARGUMENTOS que a store recebeu, não só "foi chamado".
 *
 * O jsdom não faz layout nenhum, e o motor de conexão decide "qual handle
 * está sob o cursor" de duas formas (`isValidHandle`, em `@xyflow/system`):
 * `document.elementFromPoint` (sempre `null` no jsdom — por isso ele é
 * travado abaixo) OU a distância até o handle mais próximo em COORDENADAS DE
 * CANVAS, calculada a partir de `node.internals.handleBounds` — que só existe
 * depois de um `ResizeObserver` de verdade medir `getBoundingClientRect` de
 * cada alça (`getHandleBounds`, em `@xyflow/system`). Por isso os retângulos
 * são forjados (`forjarCartao`) e o `ResizeObserver` mockado é disparado à
 * mão (`flushObservadoresDeRedimensionamento`) ANTES do gesto.
 */
describe("conexão real de handle a handle pelo motor do @xyflow/react", () => {
  it("arrasta da alça DIREITA de um cartão até a alça ESQUERDA de outro e a store recebe os dois handles", () => {
    const n1: NoDoMapa = { id: "n1", type: "cartaoMental", position: { x: 0, y: 0 }, width: 100, height: 50, data: { label: "Nó 1" } };
    const n2: NoDoMapa = { id: "n2", type: "cartaoMental", position: { x: 300, y: 0 }, width: 100, height: 50, data: { label: "Nó 2" } };
    useMapaMentalStore.setState({ mapaAtivoId: "m1", statusGrafo: "ready", nos: [n1, n2], arestas: [] });
    applyMindmapChangesMock.mockResolvedValue(grafoVazio("m1"));

    // Envolve a `conectar` REAL (não substitui o comportamento) só pra
    // capturar os argumentos exatos que o `onConnect` do `<ReactFlow>`
    // repassa pra store — a mesma técnica de `applyMindmapChangesMock`
    // acima, um nível abaixo.
    const conectarOriginal = useMapaMentalStore.getState().conectar;
    const conectarSpy = vi.fn((conexao: Parameters<typeof conectarOriginal>[0]) => conectarOriginal(conexao));
    useMapaMentalStore.setState({ conectar: conectarSpy });

    // `elementFromPoint` não existe de verdade no jsdom (sempre `null`) — sem
    // travar explicitamente, `isValidHandle` (`@xyflow/system`) cai direto no
    // fallback por distância mesmo assim, mas travar aqui documenta que essa
    // é a rota testada, não a de `elementFromPoint`.
    document.elementFromPoint = () => null;

    const { container } = render(<ConteudoDeMapaMental />);

    const noUm = forjarCartao(container, "n1", { left: 0, top: 0, width: 100, height: 50 });
    const noDois = forjarCartao(container, "n2", { left: 300, top: 0, width: 100, height: 50 });
    flushObservadoresDeRedimensionamento();

    const alcaDireitaDoNoUm = noUm.querySelector<HTMLElement>('[data-handleid="right"]');
    if (!alcaDireitaDoNoUm) throw new Error('alça "right" do nó n1 não renderizou');
    if (!noDois.querySelector('[data-handleid="left"]')) throw new Error('alça "left" do nó n2 não renderizou');

    // Converte a posição-alvo (a alça "left" do n2, em coordenadas de
    // CANVAS: absoluta do nó (300,0) + meia altura (25) = (300,25), central
    // pela borda esquerda) pra coordenadas de TELA — o inverso do que
    // `pointToRendererPoint` faz dentro do motor de conexão — usando o
    // `translate`/`scale` que o `fitView` de verdade aplicou no viewport
    // (lido da DOM, nunca assumido como identidade).
    const { translateX, translateY, scale } = lerTransformDoViewport(container);
    const alvoCanvas = { x: 300, y: 25 };
    const alvoTela = { x: translateX + alvoCanvas.x * scale, y: translateY + alvoCanvas.y * scale };

    // `XYHandle.onPointerDown` (`@xyflow/system`) anexa os listeners de
    // `mousemove`/`mouseup` em `getHostForElement(event.target)` —
    // `element.getRootNode()`, que resolve pra `document` (não `window`,
    // diferente do `d3-drag` usado no arrasto do CORPO do cartão acima) —
    // por isso os dois disparam em `document`.
    dispararMouse(alcaDireitaDoNoUm, "mousedown", { clientX: 100, clientY: 25 });
    // Duas `mousemove`: a primeira só passa do limiar de conexão
    // (`connectionDragThreshold`, ver `onPointerDown` em `@xyflow/system`) —
    // sem ela, o motor nunca chama `startConnection` e a segunda posição
    // (o alvo de verdade) seria a ÚNICA lida, o que ainda funcionaria aqui,
    // mas duas etapas espelham o gesto real de arrastar.
    dispararMouse(document, "mousemove", { clientX: (100 + alvoTela.x) / 2, clientY: (25 + alvoTela.y) / 2 });
    dispararMouse(document, "mousemove", { clientX: alvoTela.x, clientY: alvoTela.y });
    dispararMouse(document, "mouseup", { clientX: alvoTela.x, clientY: alvoTela.y });

    expect(conectarSpy).toHaveBeenCalledTimes(1);
    expect(conectarSpy.mock.calls[0][0]).toMatchObject({
      source: "n1",
      sourceHandle: "right",
      target: "n2",
      targetHandle: "left",
    });
  });
});
