/**
 * Superfície pública desta peça (S2). Quem usa o contêiner — o bloco de
 * database inline do editor, ou a futura tela de página inteira — importa
 * daqui, nunca de um arquivo dentro desta pasta diretamente.
 */
export { DatabaseContainer } from "./DatabaseContainer";
export { DatabaseContainerBody } from "./DatabaseContainerBody";
export { DatabaseContainerHeader } from "./DatabaseContainerHeader";
export { ExpandedDatabaseOverlay } from "./ExpandedDatabaseOverlay";
export type {
  AddPropertyResult,
  DatabaseContainerActions,
  DatabaseContainerMode,
  DatabaseContainerState,
  DatabaseSchema,
} from "./types";
