/**
 * Registra `person` (arquitetura §6 — contato local, consumido por
 * DBS-082/083/120). Importado de lugar nenhum — `core/discover-extensions.ts`
 * carrega este arquivo pelo nome `register.ts`.
 */
import { registerPropertySpec } from "../../core/property-spec";
import { personPropertySpec } from "./person-spec";

registerPropertySpec(personPropertySpec);
