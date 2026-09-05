/**
 * Descoberto por `core/discover-extensions.ts` via `import.meta.glob` sobre
 * todo arquivo chamado `register.ts` dentro de `properties/` — nada mais
 * importa este arquivo. Pegadinha herdada da Fase 2
 * (`src/features/editor/README.md`): a pasta `properties/` sendo NOVA nesta
 * rodada, o `npm run dev` precisa reiniciar uma vez para o glob pegá-la.
 */
import { registerPropertySpec } from "../../core/property-spec";
import "./option-colors.css";
import { selectPropertySpec } from "./select-spec";

registerPropertySpec(selectPropertySpec);
