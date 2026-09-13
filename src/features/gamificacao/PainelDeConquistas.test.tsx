import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { estudoEstatisticas, type EstatisticasDeEstudo } from "../../lib/ipc";
import { PainelDeConquistas } from "./PainelDeConquistas";
import { nivelAtual, recordesPessoais, type EstadoDeNivel, type RecordesPessoais } from "./ipc";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    estudoEstatisticas: vi.fn(),
  };
});

vi.mock("./ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ipc")>();
  return {
    ...actual,
    nivelAtual: vi.fn(),
    recordesPessoais: vi.fn(),
  };
});

const nivelAtualMock = vi.mocked(nivelAtual);
const recordesPessoaisMock = vi.mocked(recordesPessoais);
const estudoEstatisticasMock = vi.mocked(estudoEstatisticas);

function nivel(overrides: Partial<EstadoDeNivel> = {}): EstadoDeNivel {
  return { nivel: 3, xpTotal: 520, xpNoNivelAtual: 20, xpParaProximoNivel: 280, progresso: 0.0667, ...overrides };
}

function recordes(overrides: Partial<RecordesPessoais> = {}): RecordesPessoais {
  return {
    melhorDia: { dia: "2026-08-20", revisoes: 42 },
    maiorSequencia: 7,
    melhorSemana: { semanaInicio: "2026-08-16", revisoes: 150 },
    ...overrides,
  };
}

function estatisticas(overrides: Partial<EstatisticasDeEstudo> = {}): EstatisticasDeEstudo {
  return {
    porDia: [],
    totalRevisoes: 0,
    mediaDiaria: 0,
    diasEstudados: 0,
    maiorSequencia: 0,
    sequenciaAtual: 0,
    retencao: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PainelDeConquistas", () => {
  it("mostra nível, XP e recordes pessoais", async () => {
    nivelAtualMock.mockResolvedValue(nivel());
    recordesPessoaisMock.mockResolvedValue(recordes());
    estudoEstatisticasMock.mockResolvedValue(estatisticas());

    render(<PainelDeConquistas />);

    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("520")).toBeInTheDocument();
    expect(screen.getByText("42 revisões")).toBeInTheDocument();
    expect(screen.getByText("7 dias")).toBeInTheDocument();
    expect(screen.getByText("150 revisões")).toBeInTheDocument();
  });

  it("nunca existe ranking contra outra pessoa — só recordes contra o próprio histórico", async () => {
    nivelAtualMock.mockResolvedValue(nivel());
    recordesPessoaisMock.mockResolvedValue(recordes());
    estudoEstatisticasMock.mockResolvedValue(estatisticas());

    render(<PainelDeConquistas />);

    await screen.findByText("Seus recordes");
    expect(screen.queryByText(/ranking/i)).not.toBeInTheDocument();
  });

  it("sem nenhuma revisão no histórico, melhor dia e melhor semana dizem isso honestamente", async () => {
    nivelAtualMock.mockResolvedValue(nivel({ xpTotal: 30 }));
    recordesPessoaisMock.mockResolvedValue(recordes({ melhorDia: null, melhorSemana: null, maiorSequencia: 0 }));
    estudoEstatisticasMock.mockResolvedValue(estatisticas());

    render(<PainelDeConquistas />);

    expect(await screen.findAllByText("Nenhuma revisão registrada ainda")).toHaveLength(1);
    expect(screen.getByText("Nenhuma semana registrada ainda")).toBeInTheDocument();
  });

  it("atividade recente mostra revisões por dia, nunca rotulada como XP", async () => {
    nivelAtualMock.mockResolvedValue(nivel());
    recordesPessoaisMock.mockResolvedValue(recordes());
    estudoEstatisticasMock.mockResolvedValue(
      estatisticas({ porDia: [{ dia: "2026-09-01", revisoes: 10, segundos: 600 }] }),
    );

    render(<PainelDeConquistas />);

    expect(await screen.findByText("Revisões por dia (últimos 14 dias)")).toBeInTheDocument();
    expect(screen.getByText("2026-09-01")).toBeInTheDocument();
  });

  it("sem revisão na janela recente, diz isso em vez de mostrar barras vazias", async () => {
    nivelAtualMock.mockResolvedValue(nivel());
    recordesPessoaisMock.mockResolvedValue(recordes());
    estudoEstatisticasMock.mockResolvedValue(estatisticas({ porDia: [] }));

    render(<PainelDeConquistas />);

    expect(await screen.findByText("Sem revisões nos últimos 14 dias.")).toBeInTheDocument();
  });

  it("estado vazio: quem nunca gerou XP vê um convite, não recordes zerados", async () => {
    nivelAtualMock.mockResolvedValue(nivel({ xpTotal: 0 }));
    recordesPessoaisMock.mockResolvedValue(recordes({ melhorDia: null, melhorSemana: null, maiorSequencia: 0 }));
    estudoEstatisticasMock.mockResolvedValue(estatisticas());

    render(<PainelDeConquistas />);

    expect(await screen.findByText("Ainda sem conquistas por aqui")).toBeInTheDocument();
    expect(screen.queryByText("Seus recordes")).not.toBeInTheDocument();
  });

  it("erro em qualquer uma das chamadas vira mensagem visível em vez de tela branca", async () => {
    nivelAtualMock.mockRejectedValue(new Error("rede caiu"));
    recordesPessoaisMock.mockResolvedValue(recordes());
    estudoEstatisticasMock.mockResolvedValue(estatisticas());

    render(<PainelDeConquistas />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar suas conquistas.");
  });
});
