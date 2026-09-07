/**
 * Registra a view `"table"` (`database_views.view_type`). Descoberto por
 * `core/discover-extensions.ts` via `import.meta.glob` — este arquivo não é
 * importado de lugar nenhum (arquitetura §6), e `DatabaseContainer.tsx` já
 * dispara a descoberta. Pegadinha herdada da Fase 2: `views/` é uma pasta
 * NOVA, então só entra depois de reiniciar o `npm run dev`.
 */
import { registerViewSpec } from "../../core/view-spec";
import { renderTableView } from "./TableView";

export const TABLE_VIEW_TYPE = "table";

registerViewSpec<unknown>({
  type: TABLE_VIEW_TYPE,
  label: "Tabela",
  icon: "▦",
  // O `config` real é o `ViewConfig` de `view-config/` (DBS-053), lido com
  // `readViewConfig` — que tolera `{}` e qualquer blob parcial.
  defaultConfig: {},
  render: renderTableView,
});
