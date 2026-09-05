/**
 * Ponto de entrada único desta pasta — o único arquivo aqui chamado
 * "register.ts", descoberto por `core/discover-extensions.ts` via
 * `import.meta.glob` (mesmo mecanismo do editor na Fase 2). Registra o tipo
 * de propriedade "files" (DBS-016).
 */
import { registerPropertySpec } from "../../core/property-spec";
import { filesPropertySpec } from "./files-property-spec";

registerPropertySpec(filesPropertySpec);
