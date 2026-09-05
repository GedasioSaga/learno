/**
 * As duas metades de renderização de `checkboxPropertySpec`
 * (`checkbox-spec.ts`). Diferente de texto/número/URL, um checkbox não tem
 * um estado intermediário de "rascunho não confirmado" — DBS-017 pede que UM
 * clique já alterne e persista. Por isso `CheckboxCellEditor` confirma
 * (`commit`) e fecha (`close`) na MESMA interação: não existe "modo de
 * edição" visualmente distinto do valor, só a diferença de quem detém
 * `commit` na interface (`CellRenderContext` não tem; `CellEditContext` tem).
 *
 * Nota para quem monta a grade (Tabela/Board, fora desta pasta): um clique
 * numa célula de checkbox deve invocar `renderEditor` diretamente — não há
 * "clique para entrar em edição, clique de novo para marcar" para este tipo.
 */
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import type { CheckboxConfig } from "./checkbox-spec";

/**
 * Somente leitura: usado quando `ctx.readOnly` (propriedade DERIVADA — nunca
 * `isLocked`, DBS-002) ou em qualquer contexto que só mostra o estado sem
 * oferecer edição. `disabled` já tira do tab order e anuncia "desabilitado"
 * pro leitor de tela sem precisar de `aria-*` adicional — HTML semântico
 * antes de ARIA.
 */
export function CheckboxCellValue({ value, property, readOnly }: CellRenderContext<boolean, CheckboxConfig>) {
  return (
    <input
      type="checkbox"
      className="db-cell-checkbox"
      checked={value === true}
      disabled={readOnly}
      // Somente leitura por natureza — o valor muda só via `renderEditor`.
      onChange={() => {}}
      aria-label={property.name}
    />
  );
}

/**
 * `onChange` (não `onClick`): cobre clique do mouse E Espaço/Enter com o
 * foco no controle, que é como um `<input type="checkbox">` nativo já
 * funciona sem JS adicional.
 */
export function CheckboxCellEditor({ value, property, commit, close }: CellEditContext<boolean, CheckboxConfig>) {
  return (
    <input
      type="checkbox"
      className="db-cell-checkbox"
      checked={value === true}
      autoFocus
      onChange={(event) => {
        commit(event.target.checked);
        close();
      }}
      aria-label={property.name}
    />
  );
}
