/**
 * O contrato de IPC de Gamificação mora em `src/lib/ipc.ts` — este arquivo é
 * só reexportação, para os 4 arquivos desta pasta que importam de "./ipc"
 * continuarem funcionando sem mudança.
 *
 * Consolidado ali porque `contrato-ipc.test.ts` (a trava que compara tipo
 * TypeScript contra struct Rust campo a campo) só lê `src/lib/ipc.ts`: os
 * tipos abaixo, enquanto viviam só aqui, nunca entravam nessa comparação.
 */
export {
  desafiosHoje,
  nivelAtual,
  recordesPessoais,
  registrarXpDesafioDiario,
  xpTotal,
  type Desafio,
  type EstadoDeNivel,
  type MelhorDia,
  type MelhorSemana,
  type OrigemXp,
  type RecordesPessoais,
  type TipoDesafio,
  type XpEventRow,
} from "../../lib/ipc";
