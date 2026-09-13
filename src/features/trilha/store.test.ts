import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  anexarMaterialEtapa,
  apagarFlecha,
  createPage,
  createProperty,
  criarEtapa,
  criarFlecha,
  criarRaia,
  criarTrilhaCompleta,
  deckMaturity,
  definirPropriedadeDeAgrupamentoDaTrilha,
  definirRaiaRecolhida,
  desmarcarEtapaComoDecisao,
  desmarcarProgressoEtapa,
  escolherCaminho,
  listProperties,
  listarTrilhas,
  marcarEtapaComoDecisao,
  marcarProgressoEtapa,
  moverEtapaParaRaia,
  obterTrilha,
  preverTrocaDeCaminho,
  removerEtapa,
  removerMaterialEtapa,
  removerRaia,
  renameDatabase,
  renamePage,
  renameView,
  renomearCaminho,
  renomearRaia,
  reordenarRaia,
  trashPage,
  type DatabasePropertyRow,
  type Decisao,
  type DeckMaturity,
  type PageRow,
  type Trilha,
  type TrilhaResumo,
} from "../../lib/ipc";
import { lerLocalizacaoDaTrilha, limparLocalizacaoDaTrilha, salvarLocalizacaoDaTrilha } from "./localizacao";
import { useTrilhaStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    createPage: vi.fn(),
    criarTrilhaCompleta: vi.fn(),
    obterTrilha: vi.fn(),
    criarEtapa: vi.fn(),
    criarFlecha: vi.fn(),
    apagarFlecha: vi.fn(),
    marcarProgressoEtapa: vi.fn(),
    desmarcarProgressoEtapa: vi.fn(),
    definirRaiaRecolhida: vi.fn(),
    listarTrilhas: vi.fn(),
    renameDatabase: vi.fn(),
    renamePage: vi.fn(),
    renameView: vi.fn(),
    trashPage: vi.fn(),
    createProperty: vi.fn(),
    listProperties: vi.fn(),
    definirPropriedadeDeAgrupamentoDaTrilha: vi.fn(),
    criarRaia: vi.fn(),
    renomearRaia: vi.fn(),
    reordenarRaia: vi.fn(),
    moverEtapaParaRaia: vi.fn(),
    anexarMaterialEtapa: vi.fn(),
    removerMaterialEtapa: vi.fn(),
    removerEtapa: vi.fn(),
    removerRaia: vi.fn(),
    marcarEtapaComoDecisao: vi.fn(),
    desmarcarEtapaComoDecisao: vi.fn(),
    escolherCaminho: vi.fn(),
    renomearCaminho: vi.fn(),
    preverTrocaDeCaminho: vi.fn(),
    deckMaturity: vi.fn(),
  };
});

vi.mock("./localizacao", () => ({
  lerLocalizacaoDaTrilha: vi.fn(),
  salvarLocalizacaoDaTrilha: vi.fn(),
  limparLocalizacaoDaTrilha: vi.fn(),
}));

const createPageMock = vi.mocked(createPage);
const criarTrilhaCompletaMock = vi.mocked(criarTrilhaCompleta);
const obterTrilhaMock = vi.mocked(obterTrilha);
const criarEtapaMock = vi.mocked(criarEtapa);
const criarFlechaMock = vi.mocked(criarFlecha);
const apagarFlechaMock = vi.mocked(apagarFlecha);
const marcarProgressoEtapaMock = vi.mocked(marcarProgressoEtapa);
const desmarcarProgressoEtapaMock = vi.mocked(desmarcarProgressoEtapa);
const definirRaiaRecolhidaMock = vi.mocked(definirRaiaRecolhida);
const listarTrilhasMock = vi.mocked(listarTrilhas);
const renameDatabaseMock = vi.mocked(renameDatabase);
const renamePageMock = vi.mocked(renamePage);
const renameViewMock = vi.mocked(renameView);
const trashPageMock = vi.mocked(trashPage);
const createPropertyMock = vi.mocked(createProperty);
const listPropertiesMock = vi.mocked(listProperties);
const definirPropriedadeDeAgrupamentoDaTrilhaMock = vi.mocked(definirPropriedadeDeAgrupamentoDaTrilha);
const criarRaiaMock = vi.mocked(criarRaia);
const renomearRaiaMock = vi.mocked(renomearRaia);
const reordenarRaiaMock = vi.mocked(reordenarRaia);
const moverEtapaParaRaiaMock = vi.mocked(moverEtapaParaRaia);
const anexarMaterialEtapaMock = vi.mocked(anexarMaterialEtapa);
const removerMaterialEtapaMock = vi.mocked(removerMaterialEtapa);
const removerEtapaMock = vi.mocked(removerEtapa);
const removerRaiaMock = vi.mocked(removerRaia);
const marcarEtapaComoDecisaoMock = vi.mocked(marcarEtapaComoDecisao);
const desmarcarEtapaComoDecisaoMock = vi.mocked(desmarcarEtapaComoDecisao);
const escolherCaminhoMock = vi.mocked(escolherCaminho);
const renomearCaminhoMock = vi.mocked(renomearCaminho);
const preverTrocaDeCaminhoMock = vi.mocked(preverTrocaDeCaminho);
const deckMaturityMock = vi.mocked(deckMaturity);
const lerLocalizacaoDaTrilhaMock = vi.mocked(lerLocalizacaoDaTrilha);
const salvarLocalizacaoDaTrilhaMock = vi.mocked(salvarLocalizacaoDaTrilha);
const limparLocalizacaoDaTrilhaMock = vi.mocked(limparLocalizacaoDaTrilha);

function resumoFixture(overrides: Partial<TrilhaResumo> = {}): TrilhaResumo {
  return {
    viewId: "v1",
    databaseId: "d1",
    containerPageId: "p1",
    nome: "Trilha",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function propriedadeFixture(overrides: Partial<DatabasePropertyRow> = {}): DatabasePropertyRow {
  return {
    id: "prop1",
    databaseId: "d1",
    name: "Raia",
    propertyType: "select",
    config: {},
    position: "a0",
    createdAt: "",
    updatedAt: "",
    ...overrides,
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

function maturidadeFixture(overrides: Partial<DeckMaturity> = {}): DeckMaturity {
  return { total: 30, maduros: 12, jovens: 5, novos: 10, suspensos: 0, fracaoMaduros: 0.4, ...overrides };
}

function decisaoFixture(overrides: Partial<Decisao> = {}): Decisao {
  return {
    stepId: "e1",
    chosenLabel: null,
    chosenAt: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function pageFixture(overrides: Partial<PageRow> = {}): PageRow {
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Padrão: database sem propriedade nenhuma. `ativarRaias` consulta antes de
  // criar, e sem este padrão todo teste que não fala de raia quebraria por
  // `undefined.find`.
  listPropertiesMock.mockResolvedValue([]);
  useTrilhaStore.setState({
    status: "carregando",
    viewId: null,
    databaseId: null,
    trilha: null,
    mapaDeDecisoes: new Map(),
    errorMessage: null,
    listaStatus: "idle",
    trilhas: [],
    pendingRenameId: null,
    criandoTrilha: false,
    maturidadesPorBaralho: new Map(),
  });
});

describe("carregar", () => {
  it("sem ponteiro salvo, vai direto para 'vazia' sem chamar IPC nenhum", async () => {
    lerLocalizacaoDaTrilhaMock.mockReturnValue(null);

    await useTrilhaStore.getState().carregar();

    expect(useTrilhaStore.getState().status).toBe("vazia");
    expect(obterTrilhaMock).not.toHaveBeenCalled();
  });

  it("com ponteiro salvo, busca a trilha e fica 'pronta'", async () => {
    lerLocalizacaoDaTrilhaMock.mockReturnValue({ containerPageId: "p1", viewId: "v1" });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().carregar();

    expect(obterTrilhaMock).toHaveBeenCalledWith("v1");
    expect(useTrilhaStore.getState().status).toBe("pronta");
    expect(useTrilhaStore.getState().trilha).toEqual(trilhaFixture());
  });

  it("erro de carregar vira mensagem visível, nunca tela branca (o chamador decide a tela a partir de errorMessage)", async () => {
    lerLocalizacaoDaTrilhaMock.mockReturnValue({ containerPageId: "p1", viewId: "v1" });
    obterTrilhaMock.mockRejectedValue(new AppError({ kind: "not_found", message: "view sumiu" }));

    await useTrilhaStore.getState().carregar();

    expect(useTrilhaStore.getState().status).toBe("erro");
    expect(useTrilhaStore.getState().errorMessage).toBe("view sumiu");
  });
});

describe("criarPrimeiraTrilha", () => {
  it("cria a página e a trilha completa, salva o ponteiro e fica 'pronta'", async () => {
    createPageMock.mockResolvedValue(pageFixture());
    criarTrilhaCompletaMock.mockResolvedValue({ databaseId: "d1", trilha: trilhaFixture() });

    await useTrilhaStore.getState().criarPrimeiraTrilha();

    expect(createPageMock).toHaveBeenCalledWith(null, "Trilha");
    expect(criarTrilhaCompletaMock).toHaveBeenCalledWith("p1", "Trilha", "Trilha", null);
    expect(salvarLocalizacaoDaTrilhaMock).toHaveBeenCalledWith({ containerPageId: "p1", viewId: "v1" });
    expect(useTrilhaStore.getState().status).toBe("pronta");
    expect(useTrilhaStore.getState().trilha).toEqual(trilhaFixture());
  });

  it("página criada mas criarTrilhaCompleta falha: erro visível conta que a página ficou órfã, sem fingir sucesso", async () => {
    createPageMock.mockResolvedValue(pageFixture());
    criarTrilhaCompletaMock.mockRejectedValue(new AppError({ kind: "internal", message: "banco fora do ar" }));

    await useTrilhaStore.getState().criarPrimeiraTrilha();

    expect(useTrilhaStore.getState().status).toBe("vazia");
    expect(useTrilhaStore.getState().errorMessage).toContain("banco fora do ar");
    expect(useTrilhaStore.getState().errorMessage).toContain("Trilha");
    expect(salvarLocalizacaoDaTrilhaMock).not.toHaveBeenCalled();
  });

  it("createPage falha: nada de trilha é tentado, e o erro fica visível", async () => {
    createPageMock.mockRejectedValue(new AppError({ kind: "internal", message: "disco cheio" }));

    await useTrilhaStore.getState().criarPrimeiraTrilha();

    expect(criarTrilhaCompletaMock).not.toHaveBeenCalled();
    expect(useTrilhaStore.getState().status).toBe("vazia");
    expect(useTrilhaStore.getState().errorMessage).toBe("disco cheio");
  });
});

describe("mutações — cada uma reflete o backend na releitura, nunca calcula nível no cliente", () => {
  beforeEach(() => {
    useTrilhaStore.setState({ status: "pronta", viewId: "v1", trilha: trilhaFixture(), errorMessage: null });
  });

  it("marcar concluída: chama marcarProgressoEtapa e substitui a trilha pela releitura (é ali que a próxima etapa aparece desbloqueada)", async () => {
    marcarProgressoEtapaMock.mockResolvedValue({ stepId: "e1", state: "done", startedAt: "t0", completedAt: "t1", updatedAt: "t1" });
    const trilhaComEtapaSeguinteDesbloqueada = trilhaFixture({
      etapas: [
        {
          id: "e2",
          title: "Seguinte",
          icon: null,
          laneValue: "",
          position: "a0",
          level: 1,
          inCycle: false,
          isUnlocked: true,
          situacaoNoCaminho: "ativo",
          state: null,
          startedAt: null,
          completedAt: null,
        },
      ],
    });
    obterTrilhaMock.mockResolvedValue(trilhaComEtapaSeguinteDesbloqueada);

    await useTrilhaStore.getState().marcarProgresso("e1", "done");

    expect(marcarProgressoEtapaMock).toHaveBeenCalledWith("e1", "done");
    expect(obterTrilhaMock).toHaveBeenCalledWith("v1");
    expect(useTrilhaStore.getState().trilha).toEqual(trilhaComEtapaSeguinteDesbloqueada);
    expect(useTrilhaStore.getState().trilha?.etapas[0].isUnlocked).toBe(true);
  });

  it("criar flecha repassa os ids na mesma ordem recebida (quem chama já decidiu a ordem — ver ligacao.ts)", async () => {
    criarFlechaMock.mockResolvedValue({ blockedId: "azure", blockingId: "databricks", pathLabel: null });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().criarFlecha("azure", "databricks");

    expect(criarFlechaMock).toHaveBeenCalledWith("azure", "databricks", null);
  });

  it("apagar flecha", async () => {
    apagarFlechaMock.mockResolvedValue(undefined);
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().apagarFlecha("azure", "databricks");

    expect(apagarFlechaMock).toHaveBeenCalledWith("azure", "databricks");
  });

  it("criar etapa", async () => {
    criarEtapaMock.mockResolvedValue({
      id: "e3",
      title: "Nova",
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
    });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().criarEtapa("Nova", "");

    expect(criarEtapaMock).toHaveBeenCalledWith("v1", "Nova", "");
  });

  it("renomear etapa: chama renamePage (etapa é página-registro, não há comando dedicado) e relê a trilha", async () => {
    renamePageMock.mockResolvedValue(pageFixture({ id: "e1", title: "Novo nome" }));
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().renomearEtapa("e1", "Novo nome");

    expect(renamePageMock).toHaveBeenCalledWith("e1", "Novo nome");
    expect(obterTrilhaMock).toHaveBeenCalledWith("v1");
  });

  it("apagar etapa: chama removerEtapa e relê a trilha (é ali que a cadeia sem religação aparece)", async () => {
    removerEtapaMock.mockResolvedValue(pageFixture({ id: "e1", deleted_at: "2026-09-07" }));
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().apagarEtapa("e1");

    expect(removerEtapaMock).toHaveBeenCalledWith("e1");
    expect(obterTrilhaMock).toHaveBeenCalledWith("v1");
  });

  it("apagar raia: manda viewId + laneValue e relê a trilha — nunca apaga a etapa que estava nela (isso é responsabilidade do backend, aqui só se confere a escrita)", async () => {
    removerRaiaMock.mockResolvedValue(undefined);
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().apagarRaia("T.I.");

    expect(removerRaiaMock).toHaveBeenCalledWith("v1", "T.I.");
  });

  it("desmarcar progresso", async () => {
    desmarcarProgressoEtapaMock.mockResolvedValue(undefined);
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().desmarcarProgresso("e1");

    expect(desmarcarProgressoEtapaMock).toHaveBeenCalledWith("e1");
  });

  it("recolher raia", async () => {
    definirRaiaRecolhidaMock.mockResolvedValue({ viewId: "v1", laneValue: "", position: "a0", isCollapsed: true, createdAt: "", updatedAt: "" });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().definirRaiaRecolhida("", true);

    expect(definirRaiaRecolhidaMock).toHaveBeenCalledWith("v1", "", true);
  });

  it("erro numa mutação vira mensagem visível e NÃO relê a trilha (nada mudou de verdade no backend)", async () => {
    criarFlechaMock.mockRejectedValue(new AppError({ kind: "conflict", message: "ciclo detectado" }));

    await useTrilhaStore.getState().criarFlecha("a", "b");

    expect(useTrilhaStore.getState().errorMessage).toBe("ciclo detectado");
    expect(obterTrilhaMock).not.toHaveBeenCalled();
    // a trilha que já estava na tela continua lá — nunca vira branca.
    expect(useTrilhaStore.getState().trilha).toEqual(trilhaFixture());
  });

  it("mutação some, mas a releitura falha: mensagem avisa que a ação salvou mesmo sem confirmar visualmente", async () => {
    marcarProgressoEtapaMock.mockResolvedValue({ stepId: "e1", state: "done", startedAt: "t0", completedAt: "t1", updatedAt: "t1" });
    obterTrilhaMock.mockRejectedValue(new AppError({ kind: "internal", message: "banco caiu" }));

    await useTrilhaStore.getState().marcarProgresso("e1", "done");

    expect(useTrilhaStore.getState().errorMessage).toContain("banco caiu");
  });

  it("criar raia", async () => {
    criarRaiaMock.mockResolvedValue({ viewId: "v1", laneValue: "T.I.", position: "a0", isCollapsed: false, createdAt: "", updatedAt: "" });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().criarRaia("T.I.");

    expect(criarRaiaMock).toHaveBeenCalledWith("v1", "T.I.");
  });

  it("renomear raia manda valorAtual, não laneValue (regra 2 do relatório: era o bug herdado do wrapper de ipc.ts)", async () => {
    renomearRaiaMock.mockResolvedValue({ viewId: "v1", laneValue: "T.I. avançado", position: "a0", isCollapsed: false, createdAt: "", updatedAt: "" });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().renomearRaia("T.I.", "T.I. avançado");

    expect(renomearRaiaMock).toHaveBeenCalledWith("v1", "T.I.", "T.I. avançado");
  });

  it("reordenar raia", async () => {
    reordenarRaiaMock.mockResolvedValue({ viewId: "v1", laneValue: "T.I.", position: "a1", isCollapsed: false, createdAt: "", updatedAt: "" });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().reordenarRaia("T.I.", null);

    expect(reordenarRaiaMock).toHaveBeenCalledWith("v1", "T.I.", null);
  });

  it("mover etapa de raia", async () => {
    moverEtapaParaRaiaMock.mockResolvedValue(undefined);
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().moverEtapaParaRaia("e1", "T.I.");

    expect(moverEtapaParaRaiaMock).toHaveBeenCalledWith("e1", "v1", "T.I.");
  });

  it("anexar material", async () => {
    anexarMaterialEtapaMock.mockResolvedValue({ id: "m1", stepId: "e1", kind: "page", pageId: "p9", deckId: null, position: "a0", createdAt: "" });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().anexarMaterial("e1", "page", "p9", null);

    expect(anexarMaterialEtapaMock).toHaveBeenCalledWith("e1", "page", "p9", null);
  });

  it("remover material", async () => {
    removerMaterialEtapaMock.mockResolvedValue(undefined);
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().removerMaterial("m1");

    expect(removerMaterialEtapaMock).toHaveBeenCalledWith("m1");
  });

  it("marcar como decisão: chama marcarEtapaComoDecisao com o stepId e relê a trilha", async () => {
    marcarEtapaComoDecisaoMock.mockResolvedValue(decisaoFixture({ stepId: "e1" }));
    const trilhaComDecisao = trilhaFixture({ decisoes: [decisaoFixture({ stepId: "e1" })] });
    obterTrilhaMock.mockResolvedValue(trilhaComDecisao);

    await useTrilhaStore.getState().marcarComoDecisao("e1");

    expect(marcarEtapaComoDecisaoMock).toHaveBeenCalledWith("e1");
    expect(useTrilhaStore.getState().trilha).toEqual(trilhaComDecisao);
    // o Map derivado tem que refletir a releitura, não só o array bruto.
    expect(useTrilhaStore.getState().mapaDeDecisoes.get("e1")?.stepId).toBe("e1");
  });

  it("marcar como decisão: erro vira mensagem visível e não relê", async () => {
    marcarEtapaComoDecisaoMock.mockRejectedValue(new AppError({ kind: "internal", message: "banco fora do ar" }));

    await useTrilhaStore.getState().marcarComoDecisao("e1");

    expect(useTrilhaStore.getState().errorMessage).toBe("banco fora do ar");
    expect(obterTrilhaMock).not.toHaveBeenCalled();
  });

  it("desmarcar decisão: chama desmarcarEtapaComoDecisao com o stepId", async () => {
    desmarcarEtapaComoDecisaoMock.mockResolvedValue(undefined);
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().desmarcarDecisao("e1");

    expect(desmarcarEtapaComoDecisaoMock).toHaveBeenCalledWith("e1");
  });

  it("desmarcar decisão: backend recusa (caminho rotulado pendente) e a mensagem chega visível", async () => {
    // O backend RECUSA desmarcar enquanto existir caminho rotulado saindo da
    // etapa (ver comentário de `desmarcarEtapaComoDecisao` em lib/ipc.ts) —
    // aqui só confirmamos que a store não esconde essa recusa.
    desmarcarEtapaComoDecisaoMock.mockRejectedValue(new AppError({ kind: "conflict", message: "existe caminho rotulado saindo desta decisão" }));

    await useTrilhaStore.getState().desmarcarDecisao("e1");

    expect(useTrilhaStore.getState().errorMessage).toBe("existe caminho rotulado saindo desta decisão");
    expect(obterTrilhaMock).not.toHaveBeenCalled();
  });

  it("escolher caminho: manda decisionId e rotulo NA ORDEM CERTA (inverter os dois não dá erro nenhum — é o bug que quebra o planejamento)", async () => {
    escolherCaminhoMock.mockResolvedValue(decisaoFixture({ stepId: "dec1", chosenLabel: "Azure" }));
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().escolherCaminho("dec1", "Azure");

    expect(escolherCaminhoMock).toHaveBeenCalledWith("dec1", "Azure");
  });

  it("escolher caminho: rotulo null zera a escolha", async () => {
    escolherCaminhoMock.mockResolvedValue(decisaoFixture({ stepId: "dec1", chosenLabel: null }));
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().escolherCaminho("dec1", null);

    expect(escolherCaminhoMock).toHaveBeenCalledWith("dec1", null);
  });

  it("escolher caminho: erro vira mensagem visível", async () => {
    escolherCaminhoMock.mockRejectedValue(new AppError({ kind: "not_found", message: "decisão sumiu" }));

    await useTrilhaStore.getState().escolherCaminho("dec1", "Azure");

    expect(useTrilhaStore.getState().errorMessage).toBe("decisão sumiu");
  });

  it("renomear caminho: manda rotuloAtual e novoRotulo NA ORDEM CERTA (inverter os dois não dá erro nenhum)", async () => {
    renomearCaminhoMock.mockResolvedValue(3);
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().renomearCaminho("dec1", "Azure", "Azure avançado");

    expect(renomearCaminhoMock).toHaveBeenCalledWith("dec1", "Azure", "Azure avançado");
  });

  it("renomear caminho: novoRotulo null dissolve o caminho", async () => {
    renomearCaminhoMock.mockResolvedValue(2);
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().renomearCaminho("dec1", "Azure", null);

    expect(renomearCaminhoMock).toHaveBeenCalledWith("dec1", "Azure", null);
  });

  it("renomear caminho: erro vira mensagem visível", async () => {
    renomearCaminhoMock.mockRejectedValue(new AppError({ kind: "internal", message: "banco fora do ar" }));

    await useTrilhaStore.getState().renomearCaminho("dec1", "Azure", "Azure avançado");

    expect(useTrilhaStore.getState().errorMessage).toBe("banco fora do ar");
  });
});

describe("preverTrocaDeCaminho — leitura pura: não muda a store nem relê a trilha", () => {
  beforeEach(() => {
    useTrilhaStore.setState({ status: "pronta", viewId: "v1", trilha: trilhaFixture(), errorMessage: null });
  });

  it("devolve o ImpactoDaTroca para quem chamou, sem tocar em errorMessage nem em trilha", async () => {
    const impacto = { entramNoCaminho: ["e2"], saemDoCaminho: ["e3"], saemComProgresso: ["e3"], saemConcluidas: [] };
    preverTrocaDeCaminhoMock.mockResolvedValue(impacto);
    const trilhaAntes = useTrilhaStore.getState().trilha;

    const resultado = await useTrilhaStore.getState().preverTrocaDeCaminho("dec1", "Azure avançado");

    expect(resultado).toEqual(impacto);
    // manda decisionId e novoRotulo na ordem certa, sem passar por viewId nenhum.
    expect(preverTrocaDeCaminhoMock).toHaveBeenCalledWith("dec1", "Azure avançado");
    // nada foi relido nem gravado: é leitura pura.
    expect(obterTrilhaMock).not.toHaveBeenCalled();
    expect(useTrilhaStore.getState().trilha).toBe(trilhaAntes);
    expect(useTrilhaStore.getState().errorMessage).toBeNull();
  });

  it("erro na prévia propaga para quem chamou, em vez de virar errorMessage global", async () => {
    preverTrocaDeCaminhoMock.mockRejectedValue(new AppError({ kind: "not_found", message: "decisão sumiu" }));

    await expect(useTrilhaStore.getState().preverTrocaDeCaminho("dec1", "Azure avançado")).rejects.toThrow("decisão sumiu");

    // quem pediu a prévia decide como mostrar o erro (ex.: inline no diálogo)
    // — a store não assume isso por ele.
    expect(useTrilhaStore.getState().errorMessage).toBeNull();
  });
});

describe("carregarMaturidadeDoBaralho", () => {
  it("busca e guarda no cache por deckId, com status 'pronta'", async () => {
    deckMaturityMock.mockResolvedValue(maturidadeFixture());

    await useTrilhaStore.getState().carregarMaturidadeDoBaralho("deck1");

    expect(deckMaturityMock).toHaveBeenCalledWith("deck1");
    expect(useTrilhaStore.getState().maturidadesPorBaralho.get("deck1")).toEqual({
      status: "pronta",
      maturidade: maturidadeFixture(),
    });
  });

  it("não refaz a chamada para um deckId já resolvido no cache — o ponto inteiro da estratégia de busca", async () => {
    deckMaturityMock.mockResolvedValue(maturidadeFixture());

    await useTrilhaStore.getState().carregarMaturidadeDoBaralho("deck1");
    await useTrilhaStore.getState().carregarMaturidadeDoBaralho("deck1");

    expect(deckMaturityMock).toHaveBeenCalledTimes(1);
  });

  it("dois deckId diferentes disparam duas chamadas independentes, cada um com sua própria entrada no cache", async () => {
    deckMaturityMock.mockImplementation(async (deckId) => maturidadeFixture({ total: deckId === "deck1" ? 30 : 8 }));

    await useTrilhaStore.getState().carregarMaturidadeDoBaralho("deck1");
    await useTrilhaStore.getState().carregarMaturidadeDoBaralho("deck2");

    expect(deckMaturityMock).toHaveBeenCalledTimes(2);
    expect(useTrilhaStore.getState().maturidadesPorBaralho.get("deck1")).toMatchObject({ maturidade: { total: 30 } });
    expect(useTrilhaStore.getState().maturidadesPorBaralho.get("deck2")).toMatchObject({ maturidade: { total: 8 } });
  });

  it("erro vira status 'erro' com a mensagem, sem tocar no errorMessage global (a tela mostra isto ao lado do material, não no banner)", async () => {
    deckMaturityMock.mockRejectedValue(new AppError({ kind: "not_found", message: "baralho sumiu" }));

    await useTrilhaStore.getState().carregarMaturidadeDoBaralho("deck1");

    expect(useTrilhaStore.getState().maturidadesPorBaralho.get("deck1")).toEqual({
      status: "erro",
      mensagem: "baralho sumiu",
    });
    expect(useTrilhaStore.getState().errorMessage).toBeNull();
  });

  it("marca 'carregando' no cache antes da resposta chegar", () => {
    let resolver: (valor: DeckMaturity) => void = () => {};
    deckMaturityMock.mockReturnValue(new Promise((resolve) => (resolver = resolve)));

    const promessa = useTrilhaStore.getState().carregarMaturidadeDoBaralho("deck1");

    expect(useTrilhaStore.getState().maturidadesPorBaralho.get("deck1")).toEqual({ status: "carregando" });
    resolver(maturidadeFixture());
    return promessa;
  });
});

describe("carregarTrilhas", () => {
  it("carrega a lista para o painel", async () => {
    listarTrilhasMock.mockResolvedValue([resumoFixture()]);

    await useTrilhaStore.getState().carregarTrilhas();

    expect(useTrilhaStore.getState().listaStatus).toBe("ready");
    expect(useTrilhaStore.getState().trilhas).toEqual([resumoFixture()]);
  });

  it("erro vira mensagem visível, sem tela branca", async () => {
    listarTrilhasMock.mockRejectedValue(new AppError({ kind: "internal", message: "banco fora do ar" }));

    await useTrilhaStore.getState().carregarTrilhas();

    expect(useTrilhaStore.getState().listaStatus).toBe("error");
    expect(useTrilhaStore.getState().errorMessage).toBe("banco fora do ar");
  });
});

describe("selecionarTrilha", () => {
  beforeEach(() => {
    useTrilhaStore.setState({ trilhas: [resumoFixture(), resumoFixture({ viewId: "v2", databaseId: "d2", containerPageId: "p2", nome: "Outra" })] });
  });

  it("troca para uma trilha já listada e salva o novo ponteiro", async () => {
    obterTrilhaMock.mockResolvedValue(trilhaFixture({ configuracao: { viewId: "v2", groupPropertyId: null, createdAt: "", updatedAt: "" } }));

    await useTrilhaStore.getState().selecionarTrilha("v2");

    expect(obterTrilhaMock).toHaveBeenCalledWith("v2");
    expect(salvarLocalizacaoDaTrilhaMock).toHaveBeenCalledWith({ containerPageId: "p2", viewId: "v2" });
    expect(useTrilhaStore.getState().status).toBe("pronta");
    expect(useTrilhaStore.getState().viewId).toBe("v2");
    expect(useTrilhaStore.getState().databaseId).toBe("d2");
  });

  it("viewId que não está na lista vira mensagem visível, sem chamar obterTrilha", async () => {
    await useTrilhaStore.getState().selecionarTrilha("v-inexistente");

    expect(obterTrilhaMock).not.toHaveBeenCalled();
    expect(useTrilhaStore.getState().errorMessage).toContain("não está mais na lista");
  });

  it("erro de obterTrilha vira status 'erro'", async () => {
    obterTrilhaMock.mockRejectedValue(new AppError({ kind: "not_found", message: "view sumiu" }));

    await useTrilhaStore.getState().selecionarTrilha("v2");

    expect(useTrilhaStore.getState().status).toBe("erro");
    expect(useTrilhaStore.getState().errorMessage).toBe("view sumiu");
  });
});

describe("criarNovaTrilha", () => {
  it("cria e troca para a nova trilha sem apagar a que já estava na tela (não mexe em status)", async () => {
    useTrilhaStore.setState({ status: "pronta", viewId: "v1", databaseId: "d1", trilha: trilhaFixture() });
    createPageMock.mockResolvedValue(pageFixture({ id: "p2", title: "Concursos" }));
    criarTrilhaCompletaMock.mockResolvedValue({
      databaseId: "d2",
      trilha: trilhaFixture({ configuracao: { viewId: "v2", groupPropertyId: null, createdAt: "", updatedAt: "" } }),
    });

    await useTrilhaStore.getState().criarNovaTrilha("Concursos");

    expect(createPageMock).toHaveBeenCalledWith(null, "Concursos");
    expect(criarTrilhaCompletaMock).toHaveBeenCalledWith("p2", "Concursos", "Concursos", null);
    expect(useTrilhaStore.getState().viewId).toBe("v2");
    expect(useTrilhaStore.getState().trilhas).toHaveLength(1);
    expect(useTrilhaStore.getState().trilhas[0].nome).toBe("Concursos");
    expect(useTrilhaStore.getState().pendingRenameId).toBe("v2");
    expect(useTrilhaStore.getState().criandoTrilha).toBe(false);
  });

  it("nome em branco cai no nome padrão", async () => {
    createPageMock.mockResolvedValue(pageFixture());
    criarTrilhaCompletaMock.mockResolvedValue({ databaseId: "d1", trilha: trilhaFixture() });

    await useTrilhaStore.getState().criarNovaTrilha("   ");

    expect(createPageMock).toHaveBeenCalledWith(null, "Trilha");
  });
});

describe("renomearTrilha", () => {
  it("renomeia database, view e a página-container juntos e atualiza a linha na lista", async () => {
    useTrilhaStore.setState({ trilhas: [resumoFixture()] });
    renameDatabaseMock.mockResolvedValue({
      id: "d1",
      containerPageId: "p1",
      name: "Trilha nova",
      isLocked: false,
      config: null,
      dataVersion: 1,
      createdAt: "",
      updatedAt: "",
    });
    renameViewMock.mockResolvedValue({ id: "v1", databaseId: "d1", name: "Trilha nova", viewType: "trail", config: null, position: "a0", createdAt: "", updatedAt: "" });
    // Este é o teste que falhava antes do fix: `renomearTrilha` só chamava
    // renameDatabase+renameView, então `renamePageMock` nunca era chamado e
    // o título da página-container congelava no valor de criação.
    renamePageMock.mockResolvedValue(pageFixture({ id: "p1", title: "Trilha nova" }));

    await useTrilhaStore.getState().renomearTrilha("v1", "d1", "p1", "Trilha nova");

    expect(renameDatabaseMock).toHaveBeenCalledWith("d1", "Trilha nova");
    expect(renameViewMock).toHaveBeenCalledWith("v1", "Trilha nova");
    expect(renamePageMock).toHaveBeenCalledWith("p1", "Trilha nova");
    expect(useTrilhaStore.getState().trilhas[0].nome).toBe("Trilha nova");
  });

  it("nome em branco não chama nada", async () => {
    await useTrilhaStore.getState().renomearTrilha("v1", "d1", "p1", "   ");

    expect(renameDatabaseMock).not.toHaveBeenCalled();
    expect(renameViewMock).not.toHaveBeenCalled();
    expect(renamePageMock).not.toHaveBeenCalled();
  });

  it("erro em uma das três escritas vira mensagem visível e relê a lista do servidor (as três não são uma transação)", async () => {
    useTrilhaStore.setState({ trilhas: [resumoFixture()] });
    renameDatabaseMock.mockRejectedValue(new AppError({ kind: "internal", message: "nome duplicado" }));
    renameViewMock.mockResolvedValue({ id: "v1", databaseId: "d1", name: "Outro nome", viewType: "trail", config: null, position: "a0", createdAt: "", updatedAt: "" });
    renamePageMock.mockResolvedValue(pageFixture({ id: "p1", title: "Outro nome" }));
    // `renameView`/`renamePage` "colaram" mesmo com a falha da database — é
    // exatamente essa divergência que a releitura do servidor precisa
    // revelar, em vez de a UI continuar mostrando o nome antigo como se nada
    // tivesse mudado.
    listarTrilhasMock.mockResolvedValue([resumoFixture({ nome: "Outro nome" })]);

    await useTrilhaStore.getState().renomearTrilha("v1", "d1", "p1", "Outro nome");

    expect(useTrilhaStore.getState().errorMessage).toBe("nome duplicado");
    expect(listarTrilhasMock).toHaveBeenCalled();
    expect(useTrilhaStore.getState().trilhas).toEqual([resumoFixture({ nome: "Outro nome" })]);
  });

  it("erro e a releitura de recuperação também falha: mensagem original fica visível, lista antiga permanece", async () => {
    useTrilhaStore.setState({ trilhas: [resumoFixture()] });
    renameDatabaseMock.mockRejectedValue(new AppError({ kind: "internal", message: "banco fora do ar" }));
    listarTrilhasMock.mockRejectedValue(new AppError({ kind: "internal", message: "banco fora do ar" }));

    await useTrilhaStore.getState().renomearTrilha("v1", "d1", "p1", "Outro nome");

    expect(useTrilhaStore.getState().errorMessage).toBe("banco fora do ar");
    expect(useTrilhaStore.getState().trilhas).toEqual([resumoFixture()]);
  });
});

describe("apagarTrilha", () => {
  it("apaga a trilha ATIVA: manda para a lixeira, limpa o ponteiro e volta para 'vazia'", async () => {
    useTrilhaStore.setState({ status: "pronta", viewId: "v1", databaseId: "d1", trilha: trilhaFixture(), trilhas: [resumoFixture()] });
    lerLocalizacaoDaTrilhaMock.mockReturnValue({ containerPageId: "p1", viewId: "v1" });
    trashPageMock.mockResolvedValue(pageFixture());

    await useTrilhaStore.getState().apagarTrilha("v1", "p1");

    expect(trashPageMock).toHaveBeenCalledWith("p1");
    expect(limparLocalizacaoDaTrilhaMock).toHaveBeenCalled();
    expect(useTrilhaStore.getState().status).toBe("vazia");
    expect(useTrilhaStore.getState().viewId).toBeNull();
    expect(useTrilhaStore.getState().trilha).toBeNull();
    expect(useTrilhaStore.getState().trilhas).toEqual([]);
  });

  it("apaga uma trilha que NÃO é a ativa: some da lista, mas a tela atual continua", async () => {
    useTrilhaStore.setState({
      status: "pronta",
      viewId: "v1",
      databaseId: "d1",
      trilha: trilhaFixture(),
      trilhas: [resumoFixture(), resumoFixture({ viewId: "v2", containerPageId: "p2" })],
    });
    lerLocalizacaoDaTrilhaMock.mockReturnValue({ containerPageId: "p1", viewId: "v1" });
    trashPageMock.mockResolvedValue(pageFixture());

    await useTrilhaStore.getState().apagarTrilha("v2", "p2");

    expect(limparLocalizacaoDaTrilhaMock).not.toHaveBeenCalled();
    expect(useTrilhaStore.getState().status).toBe("pronta");
    expect(useTrilhaStore.getState().viewId).toBe("v1");
    expect(useTrilhaStore.getState().trilhas).toEqual([resumoFixture()]);
  });

  it("erro de trashPage vira mensagem visível, nada muda", async () => {
    useTrilhaStore.setState({ trilhas: [resumoFixture()] });
    trashPageMock.mockRejectedValue(new AppError({ kind: "internal", message: "disco cheio" }));

    await useTrilhaStore.getState().apagarTrilha("v1", "p1");

    expect(useTrilhaStore.getState().errorMessage).toBe("disco cheio");
    expect(useTrilhaStore.getState().trilhas).toEqual([resumoFixture()]);
  });
});

describe("ativarRaias", () => {
  it("cria a propriedade 'Raia' e configura o agrupamento, depois relê a trilha", async () => {
    useTrilhaStore.setState({ viewId: "v1", databaseId: "d1", trilha: trilhaFixture() });
    createPropertyMock.mockResolvedValue(propriedadeFixture({ id: "prop1", name: "Raia" }));
    definirPropriedadeDeAgrupamentoDaTrilhaMock.mockResolvedValue({ viewId: "v1", groupPropertyId: "prop1", createdAt: "", updatedAt: "" });
    const trilhaComAgrupamento = trilhaFixture({ configuracao: { viewId: "v1", groupPropertyId: "prop1", createdAt: "", updatedAt: "" } });
    obterTrilhaMock.mockResolvedValue(trilhaComAgrupamento);

    await useTrilhaStore.getState().ativarRaias();

    expect(createPropertyMock).toHaveBeenCalledWith("d1", "Raia", "select");
    expect(definirPropriedadeDeAgrupamentoDaTrilhaMock).toHaveBeenCalledWith("v1", "prop1");
    expect(useTrilhaStore.getState().trilha).toEqual(trilhaComAgrupamento);
  });

  it("reaproveita a propriedade 'Raia' que já existe em vez de criar uma segunda", async () => {
    // O caminho do retry: a primeira tentativa criou a propriedade e falhou ao
    // apontar a view para ela. O usuário clica "Ativar raias" de novo — e não
    // pode ganhar duas propriedades com o mesmo nome na database.
    useTrilhaStore.setState({ viewId: "v1", databaseId: "d1", trilha: trilhaFixture() });
    listPropertiesMock.mockResolvedValue([
      propriedadeFixture({ id: "outra", name: "Status" }),
      propriedadeFixture({ id: "prop1", name: "Raia" }),
    ]);
    definirPropriedadeDeAgrupamentoDaTrilhaMock.mockResolvedValue({ viewId: "v1", groupPropertyId: "prop1", createdAt: "", updatedAt: "" });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().ativarRaias();

    expect(createPropertyMock).not.toHaveBeenCalled();
    expect(definirPropriedadeDeAgrupamentoDaTrilhaMock).toHaveBeenCalledWith("v1", "prop1");
  });

  it("uma propriedade 'Raia' que NÃO é select não serve: cria a certa", async () => {
    useTrilhaStore.setState({ viewId: "v1", databaseId: "d1", trilha: trilhaFixture() });
    listPropertiesMock.mockResolvedValue([propriedadeFixture({ id: "texto", name: "Raia", propertyType: "text" })]);
    createPropertyMock.mockResolvedValue(propriedadeFixture({ id: "prop1", name: "Raia" }));
    definirPropriedadeDeAgrupamentoDaTrilhaMock.mockResolvedValue({ viewId: "v1", groupPropertyId: "prop1", createdAt: "", updatedAt: "" });
    obterTrilhaMock.mockResolvedValue(trilhaFixture());

    await useTrilhaStore.getState().ativarRaias();

    expect(createPropertyMock).toHaveBeenCalledWith("d1", "Raia", "select");
    expect(definirPropriedadeDeAgrupamentoDaTrilhaMock).toHaveBeenCalledWith("v1", "prop1");
  });

  it("sem trilha ativa, não faz nada", async () => {
    await useTrilhaStore.getState().ativarRaias();

    expect(createPropertyMock).not.toHaveBeenCalled();
    expect(listPropertiesMock).not.toHaveBeenCalled();
  });

  it("erro ao criar a propriedade vira mensagem visível", async () => {
    useTrilhaStore.setState({ viewId: "v1", databaseId: "d1", trilha: trilhaFixture() });
    createPropertyMock.mockRejectedValue(new AppError({ kind: "internal", message: "banco fora do ar" }));

    await useTrilhaStore.getState().ativarRaias();

    expect(useTrilhaStore.getState().errorMessage).toContain("banco fora do ar");
    expect(definirPropriedadeDeAgrupamentoDaTrilhaMock).not.toHaveBeenCalled();
  });
});
