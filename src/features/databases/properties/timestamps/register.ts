/**
 * DBS-024/026: registra `created_time`/`last_edited_time`. Importado de
 * lugar nenhum — `core/discover-extensions.ts` carrega este arquivo pelo
 * nome `register.ts` (mesma pegadinha da Fase 2 documentada lá: uma pasta
 * `properties/` nova só entra depois de reiniciar `npm run dev`).
 */
import { registerPropertySpec } from "../../core/property-spec";
import { createdTimePropertySpec, lastEditedTimePropertySpec } from "./timestamp-spec";

registerPropertySpec(createdTimePropertySpec);
registerPropertySpec(lastEditedTimePropertySpec);
