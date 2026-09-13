import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/ipc";
import {
  confirmarRecorrente,
  criarLancamento,
  listarCategoriasFinancas,
  listarLancamentosDoMes,
  listarRecorrentes,
  resumoFinanceiroDoMes,
  visaoFinanceiraPorMeses,
  type ResumoDoMes,
} from "./ipc";
import { MESES_NA_VISAO, useFinancasStore } from "./store";

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return {
    ...actual,
    listarCategoriasFinancas: vi.fn(),
    listarRecorrentes: vi.fn(),
    listarLancamentosDoMes: vi.fn(),
    resumoFinanceiroDoMes: vi.fn(),
    visaoFinanceiraPorMeses: vi.fn(),
    criarLancamento: vi.fn(),
    confirmarRecorrente: vi.fn(),
  };
});

const resumoMock = vi.mocked(resumoFinanceiroDoMes);
const lancamentosMock = vi.mocked(listarLancamentosDoMes);
const visaoMock = vi.mocked(visaoFinanceiraPorMeses);
const criarLancamentoMock = vi.mocked(criarLancamento);
const confirmarMock = vi.mocked(confirmarRecorrente);

function resumo(mes: string, overrides: Partial<ResumoDoMes> = {}): ResumoDoMes {
  return {
    mes,
    entradasPrevistas: 0,
    saidasPrevistas: 0,
    entradasRealizadas: 0,
    saidasRealizadas: 0,
    sobraPrevista: 0,
    sobraRealizada: 0,
    fixos: [],
    porCategoria: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listarCategoriasFinancas).mockResolvedValue([]);
  vi.mocked(listarRecorrentes).mockResolvedValue([]);
  lancamentosMock.mockResolvedValue([]);
  visaoMock.mockResolvedValue([]);
  resumoMock.mockImplementation(async (mes) => resumo(mes));
  useFinancasStore.setState({
    mes: "2026-09",
    subAba: "visao-geral",
    status: "idle",
    errorMessage: null,
    categorias: [],
    recorrentes: [],
    lancamentos: [],
    resumo: null,
    visaoPorMeses: [],
  });
});

describe("carregar", () => {
  it("busca tudo do mês aberto e fica 'ready'", async () => {
    resumoMock.mockResolvedValue(resumo("2026-09", { sobraPrevista: 401000 }));

    await useFinancasStore.getState().carregar();

    const state = useFinancasStore.getState();
    expect(state.status).toBe("ready");
    expect(state.resumo?.sobraPrevista).toBe(401000);
    expect(lancamentosMock).toHaveBeenCalledWith("2026-09");
    expect(visaoMock).toHaveBeenCalledWith("2026-09", MESES_NA_VISAO);
  });

  it("mostra a mensagem do backend quando a carga falha", async () => {
    resumoMock.mockRejectedValue(new AppError({ kind: "database", message: "disco cheio" }));

    await useFinancasStore.getState().carregar();

    expect(useFinancasStore.getState().status).toBe("error");
    expect(useFinancasStore.getState().errorMessage).toBe("disco cheio");
  });

  it("uma resposta atrasada de um mês antigo não sobrescreve o mês novo", async () => {
    let liberarSetembro: (valor: ResumoDoMes) => void = () => undefined;
    resumoMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          liberarSetembro = resolve;
        }),
    );

    const cargaDeSetembro = useFinancasStore.getState().carregar();
    await useFinancasStore.getState().definirMes("2026-10");
    liberarSetembro(resumo("2026-09"));
    await cargaDeSetembro;

    expect(useFinancasStore.getState().mes).toBe("2026-10");
    expect(useFinancasStore.getState().resumo?.mes).toBe("2026-10");
  });
});

describe("mês", () => {
  it("deslocar atravessa a virada de ano e recarrega", async () => {
    useFinancasStore.setState({ mes: "2026-12" });

    await useFinancasStore.getState().deslocarMes(1);

    expect(useFinancasStore.getState().mes).toBe("2027-01");
    expect(resumoMock).toHaveBeenLastCalledWith("2027-01");
  });

  it("trocar de sub-aba mantém o mês", () => {
    useFinancasStore.getState().definirSubAba("lancamentos");

    expect(useFinancasStore.getState().subAba).toBe("lancamentos");
    expect(useFinancasStore.getState().mes).toBe("2026-09");
  });
});

describe("ações", () => {
  it("criar lançamento chama o backend e recarrega o mês", async () => {
    criarLancamentoMock.mockResolvedValue({} as Awaited<ReturnType<typeof criarLancamento>>);

    await useFinancasStore.getState().criarLancamento({
      dataLocal: "2026-09-30",
      descricao: "Mercado",
      tipo: "saida",
      categoriaId: null,
      valorCentavos: 30000,
    });

    expect(criarLancamentoMock).toHaveBeenCalledWith("2026-09-30", "Mercado", "saida", null, 30000);
    expect(resumoMock).toHaveBeenCalledWith("2026-09");
  });

  it("falha numa ação guarda a mensagem, repassa o erro e não recarrega", async () => {
    confirmarMock.mockRejectedValue(new AppError({ kind: "invalid", message: "já confirmado neste mês" }));

    await expect(useFinancasStore.getState().confirmarFixo("r1")).rejects.toThrow("já confirmado neste mês");

    expect(useFinancasStore.getState().errorMessage).toBe("já confirmado neste mês");
    expect(resumoMock).not.toHaveBeenCalled();
  });

  it("marcar fixo como pago usa o mês aberto", async () => {
    confirmarMock.mockResolvedValue({} as Awaited<ReturnType<typeof confirmarRecorrente>>);
    useFinancasStore.setState({ mes: "2027-01" });

    await useFinancasStore.getState().confirmarFixo("r1");

    expect(confirmarMock).toHaveBeenCalledWith("r1", "2027-01");
  });
});
