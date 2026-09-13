/**
 * O contrato de IPC de Backlinks (FUN-044/FUN-045) mora em `src/lib/ipc.ts`
 * — este arquivo é só reexportação, para os 2 arquivos desta pasta que
 * importam de "./ipc" continuarem funcionando sem mudança.
 *
 * Consolidado ali porque `contrato-ipc.test.ts` (a trava que compara tipo
 * TypeScript contra struct Rust campo a campo) só lê `src/lib/ipc.ts`: os
 * tipos abaixo, enquanto viviam só aqui, nunca entravam nessa comparação —
 * o mesmo defeito que já tinha sido corrigido para Gamificação e Prazos.
 */
export { listBacklinks, listOutgoingLinks, type BacklinkRow, type OutgoingLinkRow } from "../../../lib/ipc";
