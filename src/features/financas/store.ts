import { create } from "zustand";
import { AppError } from "../../lib/ipc";
import { deslocarMes, mesDe } from "./dinheiro";
import {
  atualizarLancamento as ipcAtualizarLancamento,
  atualizarRecorrente as ipcAtualizarRecorrente,
  confirmarRecorrente as ipcConfirmarRecorrente,
  criarLancamento as ipcCriarLancamento,
  criarRecorrente as ipcCriarRecorrente,
  encerrarRecorrente as ipcEncerrarRecorrente,
  listarCategoriasFinancas,
  listarLancamentosDoMes,
  listarRecorrentes,
  mudarValorRecorrente as ipcMudarValorRecorrente,
  removerLancamento as ipcRemoverLancamento,
  removerRecorrente as ipcRemoverRecorrente,
  resumoFinanceiroDoMes,
  visaoFinanceiraPorMeses,
  type CategoriaRow,
  type LancamentoPatchInput,
  type LancamentoRow,
  type LinhaDoMes,
  type RecorrenteComVigencias,
  type RecorrentePatchInput,
  type ResumoDoMes,
  type TipoFinanceiro,
} from "./ipc";

export type SubAbaDeFinancas = "visao-geral" | "lancamentos" | "renda-e-fixos";

type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Quantos meses a tabela da Visão geral mostra, a partir do mês escolhido. */
export const MESES_NA_VISAO = 12;

export interface NovoLancamento {
  dataLocal: string;
  descricao: string;
  tipo: TipoFinanceiro;
  categoriaId: string | null;
  valorCentavos: number;
}

export interface NovoRecorrente {
  descricao: string;
  tipo: TipoFinanceiro;
  categoriaId: string | null;
  valorCentavos: number;
  inicioMes: string;
}

interface FinancasState {
  /**
   * O mês aberto. Mora aqui, e não em cada sub-aba, porque é ele que liga as
   * três: trocar o mês na Visão geral e abrir Lançamentos mostra o mesmo mês.
   */
  mes: string;
  subAba: SubAbaDeFinancas;
  status: LoadStatus;
  /** Erro da última carga ou ação. Some na próxima carga bem-sucedida. */
  errorMessage: string | null;

  categorias: CategoriaRow[];
  recorrentes: RecorrenteComVigencias[];
  lancamentos: LancamentoRow[];
  resumo: ResumoDoMes | null;
  visaoPorMeses: LinhaDoMes[];

  definirSubAba: (subAba: SubAbaDeFinancas) => void;
  definirMes: (mes: string) => Promise<void>;
  deslocarMes: (deslocamento: number) => Promise<void>;
  carregar: () => Promise<void>;

  criarLancamento: (novo: NovoLancamento) => Promise<void>;
  atualizarLancamento: (lancamentoId: string, patch: LancamentoPatchInput) => Promise<void>;
  removerLancamento: (lancamentoId: string) => Promise<void>;

  criarRecorrente: (novo: NovoRecorrente) => Promise<void>;
  atualizarRecorrente: (recorrenteId: string, patch: RecorrentePatchInput) => Promise<void>;
  mudarValorRecorrente: (recorrenteId: string, valorCentavos: number, mes: string) => Promise<void>;
  encerrarRecorrente: (recorrenteId: string, ultimoMes: string) => Promise<void>;
  removerRecorrente: (recorrenteId: string) => Promise<void>;
  confirmarFixo: (recorrenteId: string) => Promise<void>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * Número da carga mais recente. Trocar de mês rápido (‹ ‹ ‹) dispara várias
 * cargas; só a última pode escrever na tela, senão uma resposta atrasada de
 * agosto apareceria em cima de outubro.
 */
let cargaAtual = 0;

export const useFinancasStore = create<FinancasState>((set, get) => {
  /** Roda uma ação, grava o erro legível se falhar, e recarrega o mês se der certo. */
  async function agir(acao: () => Promise<unknown>, fallback: string): Promise<void> {
    try {
      await acao();
    } catch (error) {
      set({ errorMessage: messageFor(error, fallback) });
      throw error;
    }
    await get().carregar();
  }

  return {
    mes: mesDe(new Date()),
    subAba: "visao-geral",
    status: "idle",
    errorMessage: null,
    categorias: [],
    recorrentes: [],
    lancamentos: [],
    resumo: null,
    visaoPorMeses: [],

    definirSubAba: (subAba) => set({ subAba }),

    definirMes: async (mes) => {
      set({ mes });
      await get().carregar();
    },

    deslocarMes: async (deslocamento) => {
      await get().definirMes(deslocarMes(get().mes, deslocamento));
    },

    carregar: async () => {
      const carga = ++cargaAtual;
      const { mes } = get();
      set({ status: "loading" });
      try {
        const [categorias, recorrentes, lancamentos, resumo, visaoPorMeses] = await Promise.all([
          listarCategoriasFinancas(),
          listarRecorrentes(),
          listarLancamentosDoMes(mes),
          resumoFinanceiroDoMes(mes),
          visaoFinanceiraPorMeses(mes, MESES_NA_VISAO),
        ]);
        if (carga !== cargaAtual) return;
        set({ status: "ready", errorMessage: null, categorias, recorrentes, lancamentos, resumo, visaoPorMeses });
      } catch (error) {
        if (carga !== cargaAtual) return;
        set({ status: "error", errorMessage: messageFor(error, "Não foi possível carregar as finanças.") });
      }
    },

    criarLancamento: (novo) =>
      agir(
        () => ipcCriarLancamento(novo.dataLocal, novo.descricao, novo.tipo, novo.categoriaId, novo.valorCentavos),
        "Não foi possível salvar o lançamento.",
      ),

    atualizarLancamento: (lancamentoId, patch) =>
      agir(() => ipcAtualizarLancamento(lancamentoId, patch), "Não foi possível salvar o lançamento."),

    removerLancamento: (lancamentoId) =>
      agir(() => ipcRemoverLancamento(lancamentoId), "Não foi possível apagar o lançamento."),

    criarRecorrente: (novo) =>
      agir(
        () => ipcCriarRecorrente(novo.descricao, novo.tipo, novo.categoriaId, novo.valorCentavos, novo.inicioMes),
        "Não foi possível salvar o item fixo.",
      ),

    atualizarRecorrente: (recorrenteId, patch) =>
      agir(() => ipcAtualizarRecorrente(recorrenteId, patch), "Não foi possível salvar o item fixo."),

    mudarValorRecorrente: (recorrenteId, valorCentavos, mes) =>
      agir(() => ipcMudarValorRecorrente(recorrenteId, valorCentavos, mes), "Não foi possível mudar o valor."),

    encerrarRecorrente: (recorrenteId, ultimoMes) =>
      agir(() => ipcEncerrarRecorrente(recorrenteId, ultimoMes), "Não foi possível encerrar o item fixo."),

    removerRecorrente: (recorrenteId) =>
      agir(() => ipcRemoverRecorrente(recorrenteId), "Não foi possível apagar o item fixo."),

    confirmarFixo: (recorrenteId) =>
      agir(() => ipcConfirmarRecorrente(recorrenteId, get().mes), "Não foi possível marcar como pago."),
  };
});
