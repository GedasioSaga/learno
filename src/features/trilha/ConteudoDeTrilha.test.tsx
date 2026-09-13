import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AppError,
  apagarFlecha,
  createPage,
  criarEtapa,
  criarTrilhaCompleta,
  obterTrilha,
  type PageRow,
  type Trilha,
} from "../../lib/ipc";
import { ConteudoDeTrilha } from "./ConteudoDeTrilha";
import { useTrilhaStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    createPage: vi.fn(),
    criarTrilhaCompleta: vi.fn(),
    obterTrilha: vi.fn(),
    apagarFlecha: vi.fn(),
    criarEtapa: vi.fn(),
  };
});

const createPageMock = vi.mocked(createPage);
const criarTrilhaCompletaMock = vi.mocked(criarTrilhaCompleta);
const obterTrilhaMock = vi.mocked(obterTrilha);
const apagarFlechaMock = vi.mocked(apagarFlecha);
const criarEtapaMock = vi.mocked(criarEtapa);

/**
 * O `@xyflow/react` mede o próprio contêiner com `ResizeObserver` sem checar
 * se ele existe, e o jsdom deste projeto não o implementa — mesmo mock de
 * `ConteudoDeMapaMental.test.tsx`, escopo só deste arquivo.
 */
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

function pageFixture(): PageRow {
  return {
    id: "p1",
    parent_id: null,
    database_id: null,
    title: "Trilha",
    icon: null,
    position: "a0",
    is_favorite: false,
    deleted_at: null,
    created_at: "",
    updated_at: "",
  };
}

function trilhaFixture(overrides: Partial<Trilha> = {}): Trilha {
  return {
    configuracao: { viewId: "v1", groupPropertyId: null, createdAt: "", updatedAt: "" },
    raias: [{ viewId: "v1", laneValue: "", position: "a0", isCollapsed: false, createdAt: "", updatedAt: "" }],
    etapas: [],
    flechas: [],
    materiais: [],
    decisoes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useTrilhaStore.setState({ status: "carregando", viewId: null, trilha: null, errorMessage: null });
});

describe("ConteudoDeTrilha", () => {
  it("sem trilha nenhuma: mostra o convite, e criar leva ao canvas", async () => {
    const user = userEvent.setup();
    createPageMock.mockResolvedValue(pageFixture());
    criarTrilhaCompletaMock.mockResolvedValue({ databaseId: "d1", trilha: trilhaFixture() });

    render(<ConteudoDeTrilha />);

    expect(await screen.findByRole("heading", { level: 2, name: "Nenhuma trilha ainda" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Criar minha primeira trilha" }));

    expect(await screen.findByRole("button", { name: "+ Etapa" })).toBeInTheDocument();
    expect(createPageMock).toHaveBeenCalledWith(null, "Trilha");
    expect(criarTrilhaCompletaMock).toHaveBeenCalledWith("p1", "Trilha", "Trilha", null);
  });

  it("erro ao carregar vira mensagem visível com jeito de tentar de novo — nunca tela branca", async () => {
    localStorage.setItem("learno:trilha-localizacao", JSON.stringify({ containerPageId: "p1", viewId: "v1" }));
    obterTrilhaMock.mockRejectedValue(new AppError({ kind: "internal", message: "banco fora do ar" }));
    const user = userEvent.setup();

    render(<ConteudoDeTrilha />);

    expect(await screen.findByRole("alert")).toHaveTextContent("banco fora do ar");

    obterTrilhaMock.mockResolvedValue(trilhaFixture());
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));

    expect(await screen.findByRole("button", { name: "+ Etapa" })).toBeInTheDocument();
  });

  it("etapa bloqueada é anunciada como bloqueada para leitor de tela, com quem falta concluir", async () => {
    localStorage.setItem("learno:trilha-localizacao", JSON.stringify({ containerPageId: "p1", viewId: "v1" }));
    obterTrilhaMock.mockResolvedValue(
      trilhaFixture({
        etapas: [
          { id: "databricks", title: "Databricks", icon: null, laneValue: "", position: "a0", level: 0, inCycle: false, isUnlocked: true, situacaoNoCaminho: "ativo", state: null, startedAt: null, completedAt: null },
          { id: "azure", title: "Azure", icon: null, laneValue: "", position: "a1", level: 1, inCycle: false, isUnlocked: false, situacaoNoCaminho: "ativo", state: null, startedAt: null, completedAt: null },
        ],
        flechas: [{ blockedId: "azure", blockingId: "databricks", pathLabel: null }],
      }),
    );

    const { container } = render(<ConteudoDeTrilha />);

    await waitFor(() => expect(container.querySelector(".trilha-canvas")).toBeInTheDocument());

    // Duas fontes independentes da mesma informação (nem só desenho, nem só
    // aria-label solto): a lista `sr-only` e o `aria-label` do próprio nó.
    expect(screen.getByText("Azure — bloqueada, falta concluir Databricks.")).toBeInTheDocument();
    const noDaAzure = container.querySelector('[data-id="azure"]');
    expect(noDaAzure?.getAttribute("aria-label")).toBe("Azure — bloqueada, falta concluir Databricks.");
  });

  it("ciclo de dependência aparece como aviso visível, com botão real para apagar a flecha que o fecha", async () => {
    localStorage.setItem("learno:trilha-localizacao", JSON.stringify({ containerPageId: "p1", viewId: "v1" }));
    obterTrilhaMock.mockResolvedValue(
      trilhaFixture({
        etapas: [
          { id: "a", title: "A", icon: null, laneValue: "", position: "a0", level: 0, inCycle: true, isUnlocked: false, situacaoNoCaminho: "ativo", state: null, startedAt: null, completedAt: null },
          { id: "b", title: "B", icon: null, laneValue: "", position: "a1", level: 0, inCycle: true, isUnlocked: false, situacaoNoCaminho: "ativo", state: null, startedAt: null, completedAt: null },
        ],
        flechas: [
          { blockedId: "a", blockingId: "b", pathLabel: null },
          { blockedId: "b", blockingId: "a", pathLabel: null },
        ],
      }),
    );
    apagarFlechaMock.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<ConteudoDeTrilha />);

    const aviso = await screen.findByRole("alert");
    expect(aviso).toHaveTextContent("Ciclo de dependência");
    expect(aviso).toHaveTextContent("nunca desbloqueia sozinha");

    obterTrilhaMock.mockResolvedValue(trilhaFixture());
    const [primeiroBotao] = screen.getAllByRole("button", { name: "Apagar esta flecha" });
    await user.click(primeiroBotao);

    await waitFor(() => expect(apagarFlechaMock).toHaveBeenCalledTimes(1));
  });
});

/** Uma etapa da fixture de orientação — mesmos defaults de `etapaDeTrilha` na vitrine. */
function etapaDeOrientacao(id: string, title: string, level: number, overrides: Partial<Trilha["etapas"][number]> = {}): Trilha["etapas"][number] {
  return { id, title, icon: null, laneValue: "", position: "a0", level, inCycle: false, isUnlocked: false, situacaoNoCaminho: "ativo", state: null, startedAt: null, completedAt: null, ...overrides };
}

/**
 * Cadeia a → b → c, mais d → c (c junta dois pré-requisitos = marco).
 * "a" concluída, "b" em andamento (a próxima), "c" bloqueada por b e d.
 */
function trilhaDeOrientacao(): Trilha {
  return trilhaFixture({
    etapas: [
      etapaDeOrientacao("a", "Revisar DNA", 0, { state: "done", isUnlocked: true }),
      etapaDeOrientacao("b", "Leis de Mendel", 1, { state: "in_progress", isUnlocked: true }),
      etapaDeOrientacao("d", "Lista de exercícios", 0, { isUnlocked: true }),
      etapaDeOrientacao("c", "Simulado", 2),
    ],
    flechas: [
      { blockedId: "b", blockingId: "a", pathLabel: null },
      { blockedId: "c", blockingId: "b", pathLabel: null },
      { blockedId: "c", blockingId: "d", pathLabel: null },
    ],
  });
}

describe("ConteudoDeTrilha — orientação", () => {
  beforeEach(() => {
    localStorage.setItem("learno:trilha-localizacao", JSON.stringify({ containerPageId: "p1", viewId: "v1" }));
    obterTrilhaMock.mockResolvedValue(trilhaDeOrientacao());
  });

  it("a barra diz onde continuar (a etapa em andamento), com progresso geral e legenda só dos estados presentes", async () => {
    render(<ConteudoDeTrilha />);

    expect(await screen.findByText("Continue em")).toBeInTheDocument();
    expect(screen.getByText("Leis de Mendel", { selector: ".trilha-barra__agora-titulo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ir até lá" })).toBeInTheDocument();
    expect(screen.getByLabelText("1 de 4 etapas concluídas")).toBeInTheDocument();

    const legenda = screen.getByRole("list", { name: "Legenda dos estados" });
    expect(legenda).toHaveTextContent("Concluída");
    expect(legenda).toHaveTextContent("Em andamento");
    expect(legenda).toHaveTextContent("Bloqueada");
    expect(legenda).toHaveTextContent("Marco");
    // Nenhuma etapa em ciclo nesta trilha: a legenda não explica o que não existe.
    expect(legenda).not.toHaveTextContent("Em ciclo");
  });

  it("o cartão da próxima etapa carrega a bandeira, e o de marco carrega o selo — os dois também no aria-label do nó", async () => {
    const { container } = render(<ConteudoDeTrilha />);
    await waitFor(() => expect(container.querySelector(".trilha-canvas")).toBeInTheDocument());

    expect(screen.getByText("Continue aqui")).toBeInTheDocument();
    expect(container.querySelector('[data-id="b"] .trilha-etapa--proxima')).toBeInTheDocument();
    expect(container.querySelector('[data-id="c"] .trilha-etapa--marco')).toBeInTheDocument();
    expect(container.querySelector('[data-id="c"]')?.getAttribute("aria-label")).toContain("Marco: junta 2 pré-requisitos.");
    expect(container.querySelector('[data-id="b"]')?.getAttribute("aria-label")).toContain("Próximo passo recomendado.");
  });

  it("etapa bloqueada diz QUAIS faltam, pelo nome", async () => {
    render(<ConteudoDeTrilha />);
    expect(await screen.findByText("Faltam 2: Leis de Mendel, Lista de exercícios")).toBeInTheDocument();
  });

  it("passar o mouse numa etapa realça a cadeia dela: quem ela exige, quem ela desbloqueia, e apaga o resto", async () => {
    const user = userEvent.setup();
    const { container } = render(<ConteudoDeTrilha />);
    await waitFor(() => expect(container.querySelector('[data-id="b"]')).toBeInTheDocument());

    const noB = container.querySelector('[data-id="b"]');
    if (!noB) throw new Error("nó b não montou");
    await user.hover(noB);

    await waitFor(() => expect(container.querySelector(".trilha-canvas--com-cadeia")).toBeInTheDocument());
    expect(container.querySelector('[data-id="b"]')).toHaveClass("trilha-no--foco");
    expect(container.querySelector('[data-id="a"]')).toHaveClass("trilha-no--exige");
    expect(container.querySelector('[data-id="c"]')).toHaveClass("trilha-no--desbloqueia");
    expect(container.querySelector('[data-id="d"]')).toHaveClass("trilha-no--fora-da-cadeia");

    await user.unhover(noB);
    await waitFor(() => expect(container.querySelector(".trilha-canvas--com-cadeia")).not.toBeInTheDocument());
  });

  it("sem nada disponível, a barra explica em vez de apontar para um cartão", async () => {
    obterTrilhaMock.mockResolvedValue(
      trilhaFixture({
        etapas: [etapaDeOrientacao("a", "Feita", 0, { state: "done", isUnlocked: true }), etapaDeOrientacao("b", "Presa", 1, { inCycle: true })],
        flechas: [{ blockedId: "b", blockingId: "a", pathLabel: null }],
      }),
    );
    render(<ConteudoDeTrilha />);

    expect(await screen.findByText("Nada disponível agora — o que resta está bloqueado ou em ciclo.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nenhum próximo passo disponível" })).toBeDisabled();
  });
});

describe("ConteudoDeTrilha — bug relatado pelo usuário (etapa órfã de raia)", () => {
  beforeEach(() => {
    localStorage.setItem("learno:trilha-localizacao", JSON.stringify({ containerPageId: "p1", viewId: "v1" }));
  });

  /**
   * Reproduz literalmente o banco do usuário: `trail_lanes` com 1 linha
   * ("Estudos") e `etapas` com 4 linhas, `lane_value` NULL nas 4 (o backend
   * converte NULL para "" antes de chegar aqui). Antes do conserto de
   * `layout.ts`, `"" !== "Estudos"` deixava as 4 fora de toda faixa — o
   * canvas ficava vazio, "0 de 4 concluídas" no cabeçalho, e nenhum caminho
   * na interface levava de volta a elas ("não dá para ver, trocar de lugar,
   * não dá para fazer nada, não dá para editar").
   */
  it("as 4 etapas órfãs aparecem no canvas, e dá para selecionar e mover cada uma para a raia real", async () => {
    obterTrilhaMock.mockResolvedValue(
      trilhaFixture({
        raias: [{ viewId: "v1", laneValue: "Estudos", position: "a0", isCollapsed: false, createdAt: "", updatedAt: "" }],
        etapas: [
          etapaDeOrientacao("prog", "Programação", 0),
          etapaDeOrientacao("mat", "Matemática", 0),
          etapaDeOrientacao("ing1", "Inglês", 0),
          etapaDeOrientacao("ing2", "Inglês", 0),
        ],
      }),
    );

    const { container } = render(<ConteudoDeTrilha />);
    await waitFor(() => expect(container.querySelector(".trilha-canvas")).toBeInTheDocument());

    // "aparece no canvas": o nó existe e não está marcado `hidden` (o que
    // `layout.ts` fazia com toda etapa que não caía em faixa nenhuma era
    // pior que isto — nem chegava a existir como nó).
    const nos: HTMLElement[] = [];
    for (const id of ["prog", "mat", "ing1", "ing2"]) {
      const no = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
      expect(no).not.toBeNull();
      if (!no) throw new Error(`nó "${id}" não montou`);
      expect(no).not.toHaveAttribute("hidden");
      nos.push(no);
    }

    // "dá para selecionar... e editar": clicar seleciona o nó e abre a
    // barra de ações do cartão, com o seletor "Mover para raia" alcançável
    // — o único jeito de sair do estado órfão. `fireEvent.click` (só o
    // evento "click", sem o "mousedown" que `user.click` também dispara) de
    // propósito: um "mousedown" real dentro do `.react-flow__pane` aciona o
    // `d3-zoom` do canvas, que agenda trabalho assíncrono e acorda depois do
    // desmonte do teste com `window` já nulo — mesmo problema documentado em
    // `EtapaNode.test.tsx`, e a seleção do nó não depende de "mousedown".
    fireEvent.click(nos[0]);
    const seletorDeRaia = await screen.findByLabelText("Mover Programação para a raia");
    expect(seletorDeRaia).toBeInTheDocument();
    expect(seletorDeRaia).toBeEnabled();

    // "trocar de lugar": a raia real ("Estudos") é uma opção alcançável do
    // seletor DO CARTÃO (não do formulário "+ Etapa", que também lista
    // "Estudos" — por isso escopado a `seletorDeRaia`), não só "Sem raia".
    expect(within(seletorDeRaia).getByRole("option", { name: "Estudos" })).toBeInTheDocument();
  });
});

describe("ConteudoDeTrilha — formulário de nova etapa não cria órfã em silêncio", () => {
  beforeEach(() => {
    localStorage.setItem("learno:trilha-localizacao", JSON.stringify({ containerPageId: "p1", viewId: "v1" }));
  });

  it("com raia já existindo, a etapa nasce na raia (não em branco) por padrão", async () => {
    const trilhaComRaia = trilhaFixture({
      raias: [{ viewId: "v1", laneValue: "Estudos", position: "a0", isCollapsed: false, createdAt: "", updatedAt: "" }],
    });
    obterTrilhaMock.mockResolvedValue(trilhaComRaia);
    criarEtapaMock.mockResolvedValue(etapaDeOrientacao("nova", "Nova etapa", 0, { laneValue: "Estudos" }));
    const user = userEvent.setup();

    render(<ConteudoDeTrilha />);
    await screen.findByRole("button", { name: "+ Etapa" });

    await user.type(screen.getByPlaceholderText("Nova etapa"), "Nova etapa");
    await user.click(screen.getByRole("button", { name: "+ Etapa" }));

    await waitFor(() => expect(criarEtapaMock).toHaveBeenCalledTimes(1));
    expect(criarEtapaMock).toHaveBeenCalledWith("v1", "Nova etapa", "Estudos");
  });

  it("sem raia nenhuma (TRL-014), a etapa continua nascendo sem raia — comportamento válido, não regride", async () => {
    obterTrilhaMock.mockResolvedValue(trilhaFixture({ raias: [] }));
    criarEtapaMock.mockResolvedValue(etapaDeOrientacao("nova", "Nova etapa", 0));
    const user = userEvent.setup();

    render(<ConteudoDeTrilha />);
    await screen.findByRole("button", { name: "+ Etapa" });

    await user.type(screen.getByPlaceholderText("Nova etapa"), "Nova etapa");
    await user.click(screen.getByRole("button", { name: "+ Etapa" }));

    await waitFor(() => expect(criarEtapaMock).toHaveBeenCalledTimes(1));
    expect(criarEtapaMock).toHaveBeenCalledWith("v1", "Nova etapa", "");
  });
});
