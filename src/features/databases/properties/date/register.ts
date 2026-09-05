/**
 * Descoberto por `core/discover-extensions.ts` (`import.meta.glob`) — não
 * importe este arquivo de lugar nenhum. Depois de soltar esta pasta pela
 * primeira vez, o `npm run dev` precisa reiniciar (o glob do Vite resolve a
 * lista de pastas quando o dev server sobe).
 */
import { registerPropertySpec } from "../../core/property-spec";
import { datePropertySpec } from "./date-spec";

registerPropertySpec(datePropertySpec);
