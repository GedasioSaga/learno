/**
 * Descoberto por `core/discover-extensions.ts` via `import.meta.glob` sobre
 * todo arquivo chamado `register.ts` dentro de `properties/` — nada mais
 * importa este arquivo. `option-colors.css` é o mesmo arquivo que
 * `../select/register.ts` importa (Vite dedupe por módulo); a peça é dona
 * das duas pastas, então não há problema em compartilhar a folha de estilo.
 */
import { registerPropertySpec } from "../../core/property-spec";
import "../select/option-colors.css";
import { multiSelectPropertySpec } from "./multi-select-spec";

registerPropertySpec(multiSelectPropertySpec);
