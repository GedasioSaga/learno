/**
 * Descoberto por `core/discover-extensions.ts`'s `import.meta.glob` — este
 * arquivo não é importado de lugar nenhum (arquitetura §6).
 */
import { registerPropertySpec } from "../../core/property-spec";
import { numberPropertySpec } from "./number-spec";

registerPropertySpec(numberPropertySpec);
