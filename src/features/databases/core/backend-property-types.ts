/**
 * Os 15 tipos que o Rust aceita (`VALID_PROPERTY_TYPES` em
 * `src-tauri/src/db/databases.rs`). O registro de specs pode conhecer um
 * tipo que o backend recusa, ou vice-versa; só a interseção vira botão —
 * no "+ Propriedade" (`container/AddPropertyMenu.tsx`) e no "Tipo" do menu
 * de coluna (`views/table/ColumnHeaderMenu.tsx`).
 *
 * `relation` e `rollup` estão na lista porque o Rust CRIA os dois; mas
 * `change_property_type` e `set_property_config` recusam quando o tipo
 * atual ou o novo é um deles (a dependência entre databases não sobrevive a
 * uma troca de tipo) — `STRUCTURAL_TYPES` é o que o menu de coluna consulta
 * para nem oferecer a troca.
 */
import type { PropertyType } from "../../../lib/ipc";

const BACKEND_TYPES: ReadonlySet<string> = new Set<PropertyType>([
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "files",
  "person",
  "formula",
  "relation",
  "rollup",
  "created_time",
  "last_edited_time",
]);

export function isBackendPropertyType(type: string): type is PropertyType {
  return BACKEND_TYPES.has(type);
}

/** Tipos cuja troca (de ou para) o Rust recusa. */
export const STRUCTURAL_TYPES: ReadonlySet<string> = new Set<PropertyType>(["relation", "rollup"]);
