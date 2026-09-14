import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConteudoDeFinancas } from "./ConteudoDeFinancas";
import { AppError } from "../../lib/ipc";
import {
  confirmarRecorrente,
  criarCategoriaFinancas,
  criarLancamento,
  criarRecorrente,
  listarCategoriasFinancas,
  listarLancamentosDoMes,
  listarRecorrentes,
  mudarValorRecorrente,
  resumoFinanceiroDoMes,
  visaoFinanceiraPorMeses,
  type CategoriaRow,
  type LancamentoRow,
  type RecorrenteComVigencias,
  type ResumoDoMes,
} from "./ipc";
import { useFinancasStore } from "./store";

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
    criarRecorrente: vi.fn(),
    mudarValorRecorrente: vi.fn(),
    criarCategoriaFinancas: vi.fn(),
  };
});

const CRIADO = "2026-09-01T00:00:00Z";

const categorias: CategoriaRow[] = [
  { id: "c-salario", nome: "Salário", tipo: "entrada", ordem: 1, arquivada: false, createdAt: CRIADO, updatedAt: CRIADO },
  { id: "c-mei", nome: "MEI", tipo: "saida", ordem: 1, arquivada: false, createdAt: CRIADO, updatedAt: CRIADO },
  { id: "c-alim", nome: "Alimentação", tipo: "saida", ordem: 2, arquivada: false, createdAt: CRIADO, updatedAt: CRIADO },
];

const salario: RecorrenteComVigencias = {
  id: "r-salario",
  descricao: "Salário",
  tipo: "entrada",
  categoriaId: "c-salario",
  createdAt: CRIADO,
  updatedAt: CRIADO,
  vigencias: [
    { id: "v1", recorrenteId: "r-salario", valorCentavos: 410000, inicioMes: "2026-09", fimMes: null, createdAt: CRIADO },
  ],
};

function resumo(mes: string, overrides: Partial<ResumoDoMes> = {}): ResumoDoMes {
  return {
    mes,
    entradasPrevistas: 410000,
    saidasPrevistas: 9000,
    entradasRealizadas: 0,
    saidasRealizadas: 30000,
    sobraPrevista: 401000,
    sobraRealizada: -30000,
    fixos: [
      {
        recorrenteId: "r-mei",
        descricao: "MEI",
        tipo: "saida",
        categoriaId: "c-mei",
        valorPrevistoCentavos: 9000,
        lancamentoId: null,
        valorConfirmadoCentavos: null,
      },
    ],
    porCategoria: [{ categoriaId: "c-alim", nome: "Alimentação", saidasCentavos: 30000 }],
    ...overrides,
  };
}

const mercado: LancamentoRow = {
  id: "l1",
  dataLocal: "2026-09-30",
  descricao: "Mercado",
  tipo: "saida",
  categoriaId: "c-alim",
  valorCentavos: 30000,
  recorrenteId: null,
  mesReferencia: null,
  createdAt: CRIADO,
  updatedAt: CRIADO,
};

// Intl usa espaço inseparável entre "R$" e o número.
function texto(elemento: HTMLElement): string {
  return (elemento.textContent ?? "").replace(/ /g, " ");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listarCategoriasFinancas).mockResolvedValue(categorias);
  vi.mocked(listarRecorrentes).mockResolvedValue([salario]);
  vi.mocked(listarLancamentosDoMes).mockResolvedValue([mercado]);
  vi.mocked(resumoFinanceiroDoMes).mockImplementation(async (mes) => resumo(mes));
  vi.mocked(visaoFinanceiraPorMeses).mockResolvedValue([]);
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

describe("ConteudoDeFinancas", () => {
  it("mostra previsto e realizado do mês, com sobra negativa marcada pelo sinal", async () => {
    render(<ConteudoDeFinancas />);

    const resumoDoMes = await screen.findByRole("region", { name: "Resumo do mês" });
    expect(texto(resumoDoMes)).toContain("+R$ 4.010,00");
    expect(texto(resumoDoMes)).toContain("−R$ 300,00");
    expect(screen.getByText("setembro de 2026")).toBeInTheDocument();
  });

  it("marcar fixo como pago confirma no mês aberto", async () => {
    vi.mocked(confirmarRecorrente).mockResolvedValue(mercado);
    const user = userEvent.setup();
    render(<ConteudoDeFinancas />);

    await user.click(await screen.findByRole("button", { name: "Marcar como pago: MEI" }));

    expect(confirmarRecorrente).toHaveBeenCalledWith("r-mei", "2026-09");
  });

  it("trocar de sub-aba mantém o mês, e o mês seguinte recarrega tudo", async () => {
    const user = userEvent.setup();
    render(<ConteudoDeFinancas />);
    await screen.findByRole("region", { name: "Resumo do mês" });

    await user.click(screen.getByRole("button", { name: "Lançamentos" }));
    expect(await screen.findByText("Mercado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lançamentos" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Próximo mês" }));
    expect(await screen.findByText("outubro de 2026")).toBeInTheDocument();
    expect(listarLancamentosDoMes).toHaveBeenLastCalledWith("2026-10");
  });

  it("novo lançamento recusa valor inválido e envia centavos quando válido", async () => {
    vi.mocked(criarLancamento).mockResolvedValue(mercado);
    const user = userEvent.setup();
    useFinancasStore.setState({ subAba: "lancamentos" });
    render(<ConteudoDeFinancas />);

    await user.click(await screen.findByRole("button", { name: "+ Novo lançamento" }));
    const form = screen.getByRole("form", { name: "Novo lançamento" });
    await user.type(within(form).getByLabelText("Descrição"), "Cinema");
    await user.type(within(form).getByLabelText("Valor (R$)"), "abc");
    await user.click(within(form).getByRole("button", { name: "Lançar" }));

    expect(within(form).getByRole("alert")).toHaveTextContent("Valor inválido");
    expect(criarLancamento).not.toHaveBeenCalled();

    await user.clear(within(form).getByLabelText("Valor (R$)"));
    await user.type(within(form).getByLabelText("Valor (R$)"), "1.234,56");
    await user.selectOptions(within(form).getByLabelText("Categoria"), "Alimentação");
    await user.click(within(form).getByRole("button", { name: "Lançar" }));

    expect(criarLancamento).toHaveBeenCalledWith(expect.any(String), "Cinema", "saida", "c-alim", 123456);
  });

  it("renda mostra o valor do mês e muda o valor a partir de um mês", async () => {
    vi.mocked(mudarValorRecorrente).mockResolvedValue(salario);
    const user = userEvent.setup();
    useFinancasStore.setState({ subAba: "renda-e-fixos" });
    render(<ConteudoDeFinancas />);

    const renda = await screen.findByRole("region", { name: "Renda" });
    expect(texto(renda)).toContain("R$ 4.100,00");

    await user.click(within(renda).getByRole("button", { name: "Mudar valor" }));
    const form = within(renda).getByRole("form", { name: "Mudar valor" });
    await user.type(within(form).getByLabelText("Novo valor (R$)"), "4.387");
    await user.clear(within(form).getByLabelText("A partir de"));
    await user.type(within(form).getByLabelText("A partir de"), "2027-01");
    await user.click(within(form).getByRole("button", { name: "Mudar valor" }));

    expect(mudarValorRecorrente).toHaveBeenCalledWith("r-salario", 438700, "2027-01");
  });

  it("cadastrar fixo novo envia o mês de início", async () => {
    vi.mocked(criarRecorrente).mockResolvedValue(salario);
    const user = userEvent.setup();
    useFinancasStore.setState({ subAba: "renda-e-fixos" });
    render(<ConteudoDeFinancas />);

    await user.click(await screen.findByRole("button", { name: "+ Nova renda ou gasto fixo" }));
    const form = screen.getByRole("form", { name: "Novo item fixo" });
    await user.type(within(form).getByLabelText("Descrição"), "Telefone");
    await user.type(within(form).getByLabelText("Valor por mês (R$)"), "60");
    await user.click(within(form).getByRole("button", { name: "Cadastrar" }));

    expect(criarRecorrente).toHaveBeenCalledWith("Telefone", "saida", null, 6000, "2026-09");
  });

  it("criar categoria no lançamento deixa a nova escolhida, e o Enter não envia o lançamento", async () => {
    const pets: CategoriaRow = {
      id: "c-pets",
      nome: "Pets",
      tipo: "saida",
      ordem: 3,
      arquivada: false,
      createdAt: CRIADO,
      updatedAt: CRIADO,
    };
    vi.mocked(criarCategoriaFinancas).mockResolvedValue(pets);
    vi.mocked(criarLancamento).mockResolvedValue(mercado);
    const user = userEvent.setup();
    useFinancasStore.setState({ subAba: "lancamentos" });
    render(<ConteudoDeFinancas />);

    await user.click(await screen.findByRole("button", { name: "+ Novo lançamento" }));
    const form = screen.getByRole("form", { name: "Novo lançamento" });
    await user.click(within(form).getByRole("button", { name: "+ Nova categoria" }));
    await user.type(within(form).getByLabelText("Nome da nova categoria"), "  Pets  {Enter}");

    expect(criarCategoriaFinancas).toHaveBeenCalledWith("Pets", "saida");
    expect(criarLancamento).not.toHaveBeenCalled();
    expect(within(form).getByLabelText("Categoria")).toHaveValue("c-pets");
    expect(within(form).queryByLabelText("Nome da nova categoria")).not.toBeInTheDocument();

    await user.type(within(form).getByLabelText("Descrição"), "Ração");
    await user.type(within(form).getByLabelText("Valor (R$)"), "90");
    await user.click(within(form).getByRole("button", { name: "Lançar" }));

    expect(criarLancamento).toHaveBeenCalledWith(expect.any(String), "Ração", "saida", "c-pets", 9000);
  });

  it("nova categoria sem nome ou com nome repetido mostra o motivo e continua aberta", async () => {
    vi.mocked(criarCategoriaFinancas).mockRejectedValue(
      new AppError({ kind: "invalid", message: 'já existe uma categoria chamada "MEI"' }),
    );
    const user = userEvent.setup();
    useFinancasStore.setState({ subAba: "lancamentos" });
    render(<ConteudoDeFinancas />);

    await user.click(await screen.findByRole("button", { name: "+ Novo lançamento" }));
    const form = screen.getByRole("form", { name: "Novo lançamento" });
    await user.click(within(form).getByRole("button", { name: "+ Nova categoria" }));

    await user.click(within(form).getByRole("button", { name: "Criar" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Dê um nome à categoria.");
    expect(criarCategoriaFinancas).not.toHaveBeenCalled();

    await user.type(within(form).getByLabelText("Nome da nova categoria"), "MEI");
    await user.click(within(form).getByRole("button", { name: "Criar" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent('já existe uma categoria chamada "MEI"');
    expect(within(form).getByLabelText("Nome da nova categoria")).toHaveValue("MEI");
    expect(useFinancasStore.getState().categorias).toHaveLength(categorias.length);
  });

  it("categoria criada no item fixo nasce do tipo escolhido", async () => {
    const freela: CategoriaRow = {
      id: "c-freela",
      nome: "Freelance",
      tipo: "entrada",
      ordem: 2,
      arquivada: false,
      createdAt: CRIADO,
      updatedAt: CRIADO,
    };
    vi.mocked(criarCategoriaFinancas).mockResolvedValue(freela);
    const user = userEvent.setup();
    useFinancasStore.setState({ subAba: "renda-e-fixos" });
    render(<ConteudoDeFinancas />);

    await user.click(await screen.findByRole("button", { name: "+ Nova renda ou gasto fixo" }));
    const form = screen.getByRole("form", { name: "Novo item fixo" });
    await user.selectOptions(within(form).getByLabelText("Tipo"), "entrada");
    await user.click(within(form).getByRole("button", { name: "+ Nova categoria" }));
    await user.type(within(form).getByLabelText("Nome da nova categoria"), "Freelance");
    await user.click(within(form).getByRole("button", { name: "Criar" }));

    expect(criarCategoriaFinancas).toHaveBeenCalledWith("Freelance", "entrada");
    expect(within(form).getByLabelText("Categoria")).toHaveValue("c-freela");
  });

  it("erro na primeira carga ocupa a tela com a mensagem", async () => {
    vi.mocked(resumoFinanceiroDoMes).mockRejectedValue(new Error("falhou"));
    render(<ConteudoDeFinancas />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar as finanças.");
  });
});
