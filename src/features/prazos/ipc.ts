/**
 * O contrato de IPC de Prazos mora em `src/lib/ipc.ts` — este arquivo é só
 * reexportação, para os 10 arquivos desta pasta que importam de "./ipc"
 * continuarem funcionando sem mudança.
 *
 * Consolidado ali porque `contrato-ipc.test.ts` (a trava que compara tipo
 * TypeScript contra struct Rust campo a campo) só lê `src/lib/ipc.ts`: os
 * tipos abaixo, enquanto viviam só aqui, nunca entravam nessa comparação.
 */
export {
  atualizarPrazo,
  criarPrazo,
  listarPrazos,
  obterPrazo,
  removerPrazo,
  type PrazoComContagem,
  type PrazoPatchInput,
  type PrazoRow,
  type PrazosListados,
  type StatusDoPrazo,
} from "../../lib/ipc";
