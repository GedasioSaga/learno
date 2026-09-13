/**
 * O contrato de IPC de Finanças mora em `src/lib/ipc.ts` — mesmo motivo de
 * `features/prazos/ipc.ts`: `contrato-ipc.test.ts` só compara o que está lá.
 */
export {
  atualizarLancamento,
  atualizarRecorrente,
  confirmarRecorrente,
  criarLancamento,
  criarRecorrente,
  encerrarRecorrente,
  listarCategoriasFinancas,
  listarLancamentosDoMes,
  listarRecorrentes,
  mudarValorRecorrente,
  removerLancamento,
  removerRecorrente,
  resumoFinanceiroDoMes,
  visaoFinanceiraPorMeses,
  type CategoriaRow,
  type FixoDoMes,
  type GastoPorCategoria,
  type LancamentoPatchInput,
  type LancamentoRow,
  type LinhaDoMes,
  type RecorrenteComVigencias,
  type RecorrentePatchInput,
  type ResumoDoMes,
  type TipoFinanceiro,
  type VigenciaRow,
} from "../../lib/ipc";
