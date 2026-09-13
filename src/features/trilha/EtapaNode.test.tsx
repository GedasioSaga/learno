import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import {
  anexarMaterialEtapa,
  apagarFlecha,
  criarFlecha,
  deckMaturity,
  desmarcarEtapaComoDecisao,
  escolherCaminho,
  marcarEtapaComoDecisao,
  obterTrilha,
  preverTrocaDeCaminho,
  removerEtapa,
  removerMaterialEtapa,
  renamePage,
  type Decisao,
  type DeckMaturity,
  type DeckRow,
  type EtapaDaTrilha,
  type FlechaDaTrilha,
  type ImpactoDaTroca,
  type MaterialDaEtapa,
  type PageRow,
  type Trilha,
} from "../../lib/ipc";
import { useCartoesStore } from "../cartoes/store";
import { EtapaNode } from "./EtapaNode";
import { useTrilhaStore } from "./store";

/**
 * A ORDEM DOS DOIS IDS, e é só isso que este arquivo existe para proteger.
 *
 * `criarFlecha(blockedId, blockingId)` significa "a primeira é bloqueada PELA
 * segunda". Trocar os dois não quebra nada de forma visível: a flecha aparece
 * no canvas, o backend aceita, nenhum teste fica vermelho — ela só aponta para
 * o lado errado, e a trilha inteira passa a ensinar a ordem inversa.
 *
 * Um revisor achou que os dois caminhos de escrita de flecha do `EtapaNode` —
 * o formulário "Bloquear por…/Ligar" (a alternativa de TECLADO ao arrasto) e o
 * botão "Remover" da lista "Bloqueada por" — não tinham teste NENHUM. Os 1462
 * testes do projeto continuariam verdes com os argumentos invertidos.
 *
 * Por isso cada asserção aqui é sobre os ARGUMENTOS (`toHaveBeenCalledWith`),
 * nunca sobre a chamada ter acontecido (`toHaveBeenCalledTimes`): a segunda
 * forma passa idêntica com a inversão, e foi exatamente o que o revisor
 * encontrou no teste do painel de ciclo.
 */

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    criarFlecha: vi.fn(),
    apagarFlecha: vi.fn(),
    obterTrilha: vi.fn(),
    escolherCaminho: vi.fn(),
    preverTrocaDeCaminho: vi.fn(),
    marcarEtapaComoDecisao: vi.fn(),
    desmarcarEtapaComoDecisao: vi.fn(),
    anexarMaterialEtapa: vi.fn(),
    removerMaterialEtapa: vi.fn(),
    removerEtapa: vi.fn(),
    renamePage: vi.fn(),
    deckMaturity: vi.fn(),
  };
});

const criarFlechaMock = vi.mocked(criarFlecha);
const apagarFlechaMock = vi.mocked(apagarFlecha);
const obterTrilhaMock = vi.mocked(obterTrilha);
const escolherCaminhoMock = vi.mocked(escolherCaminho);
const preverTrocaDeCaminhoMock = vi.mocked(preverTrocaDeCaminho);
const marcarEtapaComoDecisaoMock = vi.mocked(marcarEtapaComoDecisao);
const desmarcarEtapaComoDecisaoMock = vi.mocked(desmarcarEtapaComoDecisao);
const anexarMaterialEtapaMock = vi.mocked(anexarMaterialEtapa);
const removerMaterialEtapaMock = vi.mocked(removerMaterialEtapa);
const removerEtapaMock = vi.mocked(removerEtapa);
const renamePageMock = vi.mocked(renamePage);
const deckMaturityMock = vi.mocked(deckMaturity);

function etapa(id: string, overrides: Partial<EtapaDaTrilha> = {}): EtapaDaTrilha {
  return {
    id,
    title: id,
    icon: null,
    laneValue: "",
    position: "a0",
    level: 0,
    inCycle: false,
    isUnlocked: true,
    situacaoNoCaminho: "ativo",
    state: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function flecha(blockedId: string, blockingId: string, pathLabel: string | null = null): FlechaDaTrilha {
  return { blockedId, blockingId, pathLabel };
}

/** `chosenLabel: null` é o padrão (decisão recém-marcada, sem escolha ainda) — mesmo estado de nascença descrito em `ipc.ts`. */
function decisao(stepId: string, overrides: Partial<Decisao> = {}): Decisao {
  return { stepId, chosenLabel: null, chosenAt: null, createdAt: "", updatedAt: "", ...overrides };
}

function trilha(etapas: EtapaDaTrilha[], flechas: FlechaDaTrilha[] = [], decisoes: Decisao[] = [], materiais: MaterialDaEtapa[] = []): Trilha {
  return {
    configuracao: { viewId: "v1", groupPropertyId: null, createdAt: "", updatedAt: "" },
    raias: [{ viewId: "v1", laneValue: "", position: "a0", isCollapsed: false, createdAt: "", updatedAt: "" }],
    etapas,
    flechas,
    materiais,
    decisoes,
  };
}

function material(overrides: Partial<MaterialDaEtapa> = {}): MaterialDaEtapa {
  return {
    id: "m1",
    stepId: "azure",
    kind: "deck",
    pageId: null,
    deckId: null,
    position: "a0",
    createdAt: "",
    ...overrides,
  };
}

function maturidade(overrides: Partial<DeckMaturity> = {}): DeckMaturity {
  return { total: 30, maduros: 12, jovens: 5, novos: 10, suspensos: 0, fracaoMaduros: 0.4, ...overrides };
}

function deck(overrides: Partial<DeckRow> = {}): DeckRow {
  return {
    id: "deck1",
    parentId: null,
    name: "Inglês",
    options: {},
    position: "a0",
    deletedAt: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/**
 * O `NodeToolbar` do `@xyflow/react` so desenha para um no que esta NO STORE
 * do fluxo e marcado como selecionado — renderizar o componente solto, mesmo
 * dentro de um `ReactFlowProvider`, nao basta: a barra nao aparece e o teste
 * passaria a testar um cartao sem acoes nenhumas.
 *
 * Por isso aqui monta-se um `ReactFlow` de verdade, com o no ja selecionado,
 * que e o estado em que o usuario ve os botoes.
 */
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

const nodeTypes = { trilhaEtapa: EtapaNode };

function renderizarEtapa(id: string) {
  const alvo = useTrilhaStore.getState().trilha?.etapas.find((e) => e.id === id) ?? etapa(id);
  return render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow
          nodes={[
            {
              id,
              type: "trilhaEtapa" as const,
              position: { x: 0, y: 0 },
              selected: true,
              data: { etapa: alvo, cor: null },
            },
          ]}
          edges={[]}
          nodeTypes={nodeTypes}
          // O canvas aqui e so o suporte minimo para o NodeToolbar existir.
          // Zoom e pan sao do d3-zoom, que agenda trabalho para depois do
          // desmonte e, no jsdom, acorda com `window` ja nulo — tres
          // "unhandled error" por arquivo que nao dizem nada sobre o codigo
          // testado. Desligados, porque este teste nao navega o canvas.
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
  // A releitura depois de cada mutação não é o objeto deste arquivo; devolver
  // a mesma cena mantém o teste focado nos argumentos da escrita.
  obterTrilhaMock.mockImplementation(async () => useTrilhaStore.getState().trilha ?? trilha([]));
  // `EtapaNode` lê a lista de baralhos de `useCartoesStore` (carregada por
  // `TrilhaCanvas.tsx`, não por este componente) — sem resetar aqui, um
  // teste anterior deixaria baralho/contagem vazando para o próximo.
  useCartoesStore.setState({ decksById: new Map(), contagens: new Map() });
  // Mesmo motivo, para o cache de maturidade: sem resetar, um teste que já
  // resolveu "deck1" deixaria a entrada em cache para o próximo, que então
  // nunca veria o estado "carregando" nem chamaria `deckMaturity` de novo.
  useTrilhaStore.setState({ maturidadesPorBaralho: new Map() });
  // Padrão razoável para os testes que NÃO são sobre maturidade em si (a
  // etapa selecionada com material de baralho já dispara o `useEffect` de
  // busca no mount) — sem isto, `deckMaturity()` mockado sem implementação
  // devolveria `undefined`, e o componente quebraria tentando ler
  // `.maturidade.total` de um `undefined`.
  deckMaturityMock.mockResolvedValue(maturidade());
});

describe("EtapaNode — escrita de flecha pelo teclado", () => {
  it("'Ligar' manda a etapa ATUAL como bloqueada e a escolhida como bloqueadora, nessa ordem", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure"), etapa("databricks")]),
      errorMessage: null,
    });
    criarFlechaMock.mockResolvedValue(flecha("azure", "databricks"));

    renderizarEtapa("azure");

    await user.selectOptions(screen.getByLabelText(/Bloquear azure por/), "databricks");
    await user.click(screen.getByRole("button", { name: "Ligar" }));

    // "azure é bloqueada por databricks" — invertido, a trilha ensinaria Azure
    // antes de Databricks.
    expect(criarFlechaMock).toHaveBeenCalledWith("azure", "databricks", null);
  });

  it("não chama o backend sem uma bloqueadora escolhida", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure"), etapa("databricks")]),
      errorMessage: null,
    });

    renderizarEtapa("azure");

    // O botão nasce desabilitado; clicar nele não pode disparar escrita.
    await user.click(screen.getByRole("button", { name: "Ligar" }));

    expect(criarFlechaMock).not.toHaveBeenCalled();
  });

  it("não oferece a própria etapa nem quem já a bloqueia como candidata", () => {
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure"), etapa("databricks"), etapa("sql")], [flecha("azure", "databricks")]),
      errorMessage: null,
    });

    renderizarEtapa("azure");

    const opcoes = screen.getAllByRole("option").map((opcao) => opcao.getAttribute("value"));
    expect(opcoes).not.toContain("azure");
    expect(opcoes, "quem já bloqueia não pode ser oferecido de novo").not.toContain("databricks");
    expect(opcoes).toContain("sql");
  });

  it("'Remover' apaga a flecha na mesma ordem: atual bloqueada, listada bloqueadora", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure", { isUnlocked: false }), etapa("databricks")], [flecha("azure", "databricks")]),
      errorMessage: null,
    });
    apagarFlechaMock.mockResolvedValue(undefined);

    renderizarEtapa("azure");

    await user.click(screen.getByRole("button", { name: "Remover" }));

    expect(apagarFlechaMock).toHaveBeenCalledWith("azure", "databricks");
  });
});

describe("EtapaNode — decisão e situação no caminho", () => {
  it("uma decisão mostra o selo 'Decisão' e um botão para cada rótulo que sai dela", () => {
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha(
        [etapa("raiz"), etapa("azure"), etapa("onprem")],
        [flecha("azure", "raiz", "nuvem"), flecha("onprem", "raiz", "local")],
        [decisao("raiz")],
      ),
      errorMessage: null,
    });

    renderizarEtapa("raiz");

    expect(screen.getByText("Decisão")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "nuvem" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument();
  });

  it("os três valores de situacaoNoCaminho são distinguíveis entre si — cada um com classe e texto próprios, não só cor", () => {
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha(
        [etapa("raiz"), etapa("ativa"), etapa("suspensa", { situacaoNoCaminho: "aguardandoEscolha" }), etapa("descartada", { situacaoNoCaminho: "descartado" })],
        [flecha("suspensa", "raiz", "nuvem"), flecha("descartada", "raiz", "local")],
        [decisao("raiz", { chosenLabel: "nuvem" })],
      ),
      errorMessage: null,
    });

    const ativa = renderizarEtapa("ativa");
    expect(ativa.container.querySelector('[data-situacao-no-caminho="ativo"]')).toBeInTheDocument();
    expect(ativa.container.querySelector(".trilha-etapa--aguardando-escolha, .trilha-etapa--descartada")).not.toBeInTheDocument();
    ativa.unmount();

    const suspensa = renderizarEtapa("suspensa");
    expect(suspensa.container.querySelector(".trilha-etapa--aguardando-escolha")).toBeInTheDocument();
    expect(suspensa.getByText("Aguardando escolha")).toBeInTheDocument();
    suspensa.unmount();

    const descartadaView = renderizarEtapa("descartada");
    expect(descartadaView.container.querySelector(".trilha-etapa--descartada")).toBeInTheDocument();
    // classe DIFERENTE da de "aguardandoEscolha" — a distinção não é só a cor
    // (que nenhuma das duas usa), é a forma: uma tem o anel de sombra do
    // "aguardando", a outra a opacidade do "descartada", nunca as duas.
    expect(descartadaView.container.querySelector(".trilha-etapa--aguardando-escolha")).not.toBeInTheDocument();
    expect(descartadaView.getByText("Descartada")).toBeInTheDocument();
  });

  it("etapa em suspenso diz qual decisão está esperando", () => {
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha(
        [etapa("raiz"), etapa("azure", { situacaoNoCaminho: "aguardandoEscolha" })],
        [flecha("azure", "raiz", "nuvem")],
        [decisao("raiz")],
      ),
      errorMessage: null,
    });

    renderizarEtapa("azure");

    expect(screen.getByText(/esperando a escolha de raiz/i)).toBeInTheDocument();
  });

  it("etapa descartada com progresso avisa que o trabalho continua salvo — o caso mais delicado", () => {
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha(
        [etapa("raiz"), etapa("azure", { situacaoNoCaminho: "descartado", state: "done", completedAt: "2026-01-01" })],
        [flecha("azure", "raiz", "nuvem")],
        [decisao("raiz", { chosenLabel: "local" })],
      ),
      errorMessage: null,
    });

    renderizarEtapa("azure");

    expect(screen.getByText(/raiz escolheu "local"/i)).toBeInTheDocument();
    expect(screen.getByText(/progresso desta etapa continua salvo/i)).toBeInTheDocument();
  });
});

describe("EtapaNode — marcar/desmarcar decisão", () => {
  it("etapa comum mostra 'Marcar como decisão', e o clique chama marcarEtapaComoDecisao com o id dela", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")]),
      errorMessage: null,
    });
    marcarEtapaComoDecisaoMock.mockResolvedValue(decisao("azure"));

    renderizarEtapa("azure");

    expect(screen.queryByRole("button", { name: "Desfazer decisão" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Marcar como decisão" }));

    expect(marcarEtapaComoDecisaoMock).toHaveBeenCalledWith("azure");
  });

  it("etapa já decisão mostra 'Desfazer decisão', e o clique chama desmarcarEtapaComoDecisao com o id dela", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("raiz")], [], [decisao("raiz")]),
      errorMessage: null,
    });
    desmarcarEtapaComoDecisaoMock.mockResolvedValue(undefined);

    renderizarEtapa("raiz");

    expect(screen.queryByRole("button", { name: "Marcar como decisão" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Desfazer decisão" }));

    expect(desmarcarEtapaComoDecisaoMock).toHaveBeenCalledWith("raiz");
  });
});

describe("EtapaNode — escolher caminho de uma decisão", () => {
  it("a primeira escolha chama escolherCaminho com o id da decisão e o rótulo certos, sem prever nada antes", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha(
        [etapa("raiz"), etapa("azure"), etapa("onprem")],
        [flecha("azure", "raiz", "nuvem"), flecha("onprem", "raiz", "local")],
        [decisao("raiz")],
      ),
      errorMessage: null,
    });
    escolherCaminhoMock.mockResolvedValue(decisao("raiz", { chosenLabel: "nuvem" }));

    renderizarEtapa("raiz");

    await user.click(screen.getByRole("button", { name: "nuvem" }));

    // "raiz" é a decisão, "nuvem" o rótulo — invertido ou trocado por outro
    // rótulo, a trilha escolheria o caminho errado.
    expect(escolherCaminhoMock).toHaveBeenCalledWith("raiz", "nuvem");
    expect(preverTrocaDeCaminhoMock).not.toHaveBeenCalled();
  });

  it("trocar uma escolha JÁ EXISTENTE chama preverTrocaDeCaminho antes, e só escolhe depois de 'Confirmar troca'", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha(
        [etapa("raiz"), etapa("azure"), etapa("onprem")],
        [flecha("azure", "raiz", "nuvem"), flecha("onprem", "raiz", "local")],
        [decisao("raiz", { chosenLabel: "local" })],
      ),
      errorMessage: null,
    });
    const impacto: ImpactoDaTroca = { entramNoCaminho: ["azure"], saemDoCaminho: ["onprem"], saemComProgresso: ["onprem"], saemConcluidas: [] };
    preverTrocaDeCaminhoMock.mockResolvedValue(impacto);
    escolherCaminhoMock.mockResolvedValue(decisao("raiz", { chosenLabel: "nuvem" }));

    renderizarEtapa("raiz");

    await user.click(screen.getByRole("button", { name: "nuvem" }));

    expect(preverTrocaDeCaminhoMock).toHaveBeenCalledWith("raiz", "nuvem");
    expect(escolherCaminhoMock).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Confirmar troca" }));

    expect(escolherCaminhoMock).toHaveBeenCalledWith("raiz", "nuvem");
  });

  it("se a prévia diz que nada tem progresso, troca direto sem pedir confirmação", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha(
        [etapa("raiz"), etapa("azure"), etapa("onprem")],
        [flecha("azure", "raiz", "nuvem"), flecha("onprem", "raiz", "local")],
        [decisao("raiz", { chosenLabel: "local" })],
      ),
      errorMessage: null,
    });
    const impactoSemProgresso: ImpactoDaTroca = { entramNoCaminho: [], saemDoCaminho: ["onprem"], saemComProgresso: [], saemConcluidas: [] };
    preverTrocaDeCaminhoMock.mockResolvedValue(impactoSemProgresso);
    escolherCaminhoMock.mockResolvedValue(decisao("raiz", { chosenLabel: "nuvem" }));

    renderizarEtapa("raiz");

    await user.click(screen.getByRole("button", { name: "nuvem" }));

    expect(preverTrocaDeCaminhoMock).toHaveBeenCalledWith("raiz", "nuvem");
    expect(escolherCaminhoMock).toHaveBeenCalledWith("raiz", "nuvem");
    expect(screen.queryByRole("button", { name: "Confirmar troca" })).not.toBeInTheDocument();
  });
});

describe("EtapaNode — anexar baralho como material (TRL: 'não dá para colocar card')", () => {
  it("tipo 'Baralho' lista os baralhos de useCartoesStore, não páginas", async () => {
    const user = userEvent.setup();
    useCartoesStore.setState({ decksById: new Map([[deck().id, deck()]]) });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")]),
      errorMessage: null,
    });

    renderizarEtapa("azure");

    await user.selectOptions(screen.getByLabelText("Tipo de material para azure"), "deck");

    expect(screen.getByRole("option", { name: "Inglês" })).toBeInTheDocument();
  });

  it("anexar baralho chama anexarMaterialEtapa com kind 'deck', pageId nulo e o deckId escolhido", async () => {
    const user = userEvent.setup();
    useCartoesStore.setState({ decksById: new Map([[deck().id, deck()]]) });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")]),
      errorMessage: null,
    });
    anexarMaterialEtapaMock.mockResolvedValue(material({ deckId: "deck1" }));

    renderizarEtapa("azure");

    await user.selectOptions(screen.getByLabelText("Tipo de material para azure"), "deck");
    await user.selectOptions(screen.getByLabelText("Anexar baralho como material de azure"), "deck1");
    await user.click(screen.getByRole("button", { name: "+" }));

    // `pageId` nulo é a metade da regra "pageId e deckId são exclusivos entre
    // si e precisam bater com kind" (ver o comentário de `anexarMaterialEtapa`
    // em `lib/ipc.ts`) — invertida, o backend recusaria a chamada.
    expect(anexarMaterialEtapaMock).toHaveBeenCalledWith("azure", "deck", null, "deck1");
  });

  it("material do tipo baralho aparece na lista com o nome do baralho e a contagem de devidos hoje (aprendendo + revisar)", () => {
    useCartoesStore.setState({
      decksById: new Map([[deck().id, deck()]]),
      contagens: new Map([["deck1", { novos: 9, aprendendo: 2, revisar: 5 }]]),
    });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")], [], [], [material({ deckId: "deck1" })]),
      errorMessage: null,
    });

    renderizarEtapa("azure");

    expect(screen.getByText("Inglês")).toBeInTheDocument();
    // 2 (aprendendo) + 5 (revisar) = 7 — `novos` (9) fica de fora de propósito.
    expect(screen.getByLabelText("7 cartões devidos hoje")).toBeInTheDocument();
  });

  it("baralho sem cartão devido hoje não mostra contagem nenhuma", () => {
    useCartoesStore.setState({
      decksById: new Map([[deck().id, deck()]]),
      contagens: new Map([["deck1", { novos: 9, aprendendo: 0, revisar: 0 }]]),
    });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")], [], [], [material({ deckId: "deck1" })]),
      errorMessage: null,
    });

    renderizarEtapa("azure");

    expect(screen.getByText("Inglês")).toBeInTheDocument();
    expect(screen.queryByText(/devido/)).not.toBeInTheDocument();
  });

  it("remover material de baralho chama removerMaterialEtapa com o id do material", async () => {
    const user = userEvent.setup();
    useCartoesStore.setState({ decksById: new Map([[deck().id, deck()]]) });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")], [], [], [material({ id: "m-deck-1", deckId: "deck1" })]),
      errorMessage: null,
    });
    removerMaterialEtapaMock.mockResolvedValue(undefined);

    renderizarEtapa("azure");

    await user.click(screen.getByRole("button", { name: "Remover" }));

    expect(removerMaterialEtapaMock).toHaveBeenCalledWith("m-deck-1");
  });

  it("baralho já anexado não é oferecido de novo na lista de anexar", async () => {
    const user = userEvent.setup();
    const ingles = deck();
    const espanhol = deck({ id: "deck2", name: "Espanhol" });
    useCartoesStore.setState({
      decksById: new Map([
        [ingles.id, ingles],
        [espanhol.id, espanhol],
      ]),
    });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")], [], [], [material({ deckId: "deck1" })]),
      errorMessage: null,
    });

    renderizarEtapa("azure");

    await user.selectOptions(screen.getByLabelText("Tipo de material para azure"), "deck");

    const opcoes = screen.getAllByRole("option").map((opcao) => opcao.textContent);
    expect(opcoes).not.toContain("Inglês");
    expect(opcoes).toContain("Espanhol");
  });
});

describe("EtapaNode — maturidade do baralho anexado (deck_maturity, FSRS ligado à Trilha)", () => {
  it("busca a maturidade do baralho quando o material aparece (etapa selecionada) e mostra a fração de forma legível", async () => {
    useCartoesStore.setState({ decksById: new Map([[deck().id, deck()]]) });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")], [], [], [material({ deckId: "deck1" })]),
      errorMessage: null,
    });
    deckMaturityMock.mockResolvedValue(maturidade({ total: 30, maduros: 12, fracaoMaduros: 0.4 }));

    renderizarEtapa("azure");

    expect(deckMaturityMock).toHaveBeenCalledWith("deck1");
    expect(await screen.findByText("12 de 30 maduros — já lembra disso faz tempo")).toBeInTheDocument();
  });

  it("baralho vazio (total 0) não mostra '0 de 0 maduros' — mostra que ainda não há nada para amadurecer", async () => {
    useCartoesStore.setState({ decksById: new Map([[deck().id, deck()]]) });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")], [], [], [material({ deckId: "deck1" })]),
      errorMessage: null,
    });
    deckMaturityMock.mockResolvedValue(maturidade({ total: 0, maduros: 0, jovens: 0, novos: 0, suspensos: 0, fracaoMaduros: 0 }));

    renderizarEtapa("azure");

    expect(await screen.findByText(/Baralho vazio/)).toBeInTheDocument();
    expect(screen.queryByText(/0 de 0 maduros/)).not.toBeInTheDocument();
  });

  it("erro ao buscar a maturidade aparece ao lado do material, sem derrubar o resto do cartão", async () => {
    useCartoesStore.setState({ decksById: new Map([[deck().id, deck()]]) });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")], [], [], [material({ deckId: "deck1" })]),
      errorMessage: null,
    });
    deckMaturityMock.mockRejectedValue(new Error("falha de rede"));

    renderizarEtapa("azure");

    expect(await screen.findByText("Não foi possível carregar a maturidade deste baralho.")).toBeInTheDocument();
    // o resto do cartão continua de pé — o erro não é o banner global.
    expect(screen.getByText("Inglês")).toBeInTheDocument();
  });

  it("reabrir a mesma etapa não refaz a chamada — a store cacheia por deckId", async () => {
    useCartoesStore.setState({ decksById: new Map([[deck().id, deck()]]) });
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")], [], [], [material({ deckId: "deck1" })]),
      errorMessage: null,
    });
    deckMaturityMock.mockResolvedValue(maturidade());

    const primeira = renderizarEtapa("azure");
    await screen.findByText(/maduros — já lembra disso faz tempo/);
    primeira.unmount();

    renderizarEtapa("azure");
    await screen.findByText(/maduros — já lembra disso faz tempo/);

    expect(deckMaturityMock).toHaveBeenCalledTimes(1);
  });

  it("material de página não busca nem mostra maturidade — o conceito só existe para baralho", () => {
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")], [], [], [material({ kind: "page", pageId: "p1", deckId: null })]),
      errorMessage: null,
    });

    renderizarEtapa("azure");

    expect(deckMaturityMock).not.toHaveBeenCalled();
  });
});

function pagina(overrides: Partial<PageRow> = {}): PageRow {
  return {
    id: "azure",
    parent_id: null,
    database_id: "db1",
    title: "azure",
    icon: null,
    position: "a0",
    is_favorite: false,
    deleted_at: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("EtapaNode — apagar etapa", () => {
  it("etapa sem bloqueadora e sem quem bloqueia mostra confirmação simples, sem parágrafo de cadeia", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")]),
      errorMessage: null,
    });

    renderizarEtapa("azure");
    await user.click(screen.getByRole("button", { name: "Apagar etapa" }));

    expect(screen.getByRole("alertdialog", { name: 'Apagar azure?' })).toBeInTheDocument();
    expect(screen.queryByText(/no meio de uma cadeia/)).not.toBeInTheDocument();
  });

  it("cancelar não chama removerEtapa e fecha a confirmação", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")]),
      errorMessage: null,
    });

    renderizarEtapa("azure");
    await user.click(screen.getByRole("button", { name: "Apagar etapa" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(removerEtapaMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("confirmar chama removerEtapa com o id da etapa", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")]),
      errorMessage: null,
    });
    removerEtapaMock.mockResolvedValue(pagina({ deleted_at: "2026-09-07" }));

    renderizarEtapa("azure");
    await user.click(screen.getByRole("button", { name: "Apagar etapa" }));
    await user.click(screen.getByRole("button", { name: "Apagar mesmo assim" }));

    expect(removerEtapaMock).toHaveBeenCalledWith("azure");
  });

  it("etapa no meio de uma cadeia (A → azure → C) avisa que os dois lados NÃO são religados e nomeia quem perde a bloqueadora", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha(
        [etapa("upstream"), etapa("azure"), etapa("downstream")],
        [flecha("azure", "upstream"), flecha("downstream", "azure")],
      ),
      errorMessage: null,
    });

    renderizarEtapa("azure");
    await user.click(screen.getByRole("button", { name: "Apagar etapa" }));

    const aviso = screen.getByText(/no meio de uma cadeia/);
    // Normaliza espaço/quebra de linha herdados da formatação do JSX antes de
    // procurar substring — evitar regex com `.` cruzando linha, que o `dot`
    // do JS não atravessa por padrão.
    const texto = (aviso.textContent ?? "").replace(/\s+/g, " ");
    expect(texto).toContain("upstream");
    expect(texto).toContain("downstream");
    expect(texto).toContain("NÃO");
    expect(texto).toContain("bloqueada");
    // "downstream" perde a ÚNICA bloqueadora que tinha (azure) — fica dita como desbloqueada.
    expect(texto).toContain("sem nenhuma bloqueadora");
  });
});

describe("EtapaNode — renomear etapa", () => {
  it("duplo clique no título entra em edição; Enter confirma (via blur) e chama renamePage com o id e o novo título", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")]),
      errorMessage: null,
    });
    renamePageMock.mockResolvedValue(pagina({ title: "Azure renomeado" }));

    renderizarEtapa("azure");
    // `getByText`, não `getByRole`: o corpo do cartão (fora do `NodeToolbar`,
    // que é um portal sempre visível) fica `visibility: hidden` neste arnês
    // de teste até o `ResizeObserver` medir o nó — mockado como no-op aqui —
    // e `getByRole` exclui elemento invisível da árvore de acessibilidade.
    // Texto continua achável; e `pointer-events: all` no wrapper (visível no
    // DOM) garante que o clique real do `userEvent` funciona mesmo assim.
    await user.dblClick(screen.getByText("azure"));

    const input = screen.getByLabelText("Nome da etapa azure");
    await user.clear(input);
    await user.type(input, "Azure renomeado{Enter}");

    expect(renamePageMock).toHaveBeenCalledWith("azure", "Azure renomeado");
  });

  it("Escape cancela sem chamar renamePage", async () => {
    const user = userEvent.setup();
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      trilha: trilha([etapa("azure")]),
      errorMessage: null,
    });

    renderizarEtapa("azure");
    // `getByText`, não `getByRole`: o corpo do cartão (fora do `NodeToolbar`,
    // que é um portal sempre visível) fica `visibility: hidden` neste arnês
    // de teste até o `ResizeObserver` medir o nó — mockado como no-op aqui —
    // e `getByRole` exclui elemento invisível da árvore de acessibilidade.
    // Texto continua achável; e `pointer-events: all` no wrapper (visível no
    // DOM) garante que o clique real do `userEvent` funciona mesmo assim.
    await user.dblClick(screen.getByText("azure"));

    const input = screen.getByLabelText("Nome da etapa azure");
    await user.type(input, " mudou{Escape}");

    expect(renamePageMock).not.toHaveBeenCalled();
    expect(screen.getByText("azure")).toBeInTheDocument();
  });
});
