/**
 * Descoberto por `core/discover-extensions.ts`'s `import.meta.glob` — este
 * arquivo não é importado de lugar nenhum (arquitetura §6). Registrar aqui é
 * o que faz "Fórmula" aparecer no `AddPropertyMenu`.
 */
import { registerPropertySpec } from "../../core/property-spec";
import { formulaPropertySpec } from "./formula-spec";

registerPropertySpec(formulaPropertySpec);
