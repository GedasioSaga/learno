/**
 * As duas metades de renderização que `date-spec.ts` monta em
 * `renderValue`/`renderEditor` — mesmo corte que `number-cell.tsx` faz para
 * Número. `<input type="date">`/`<input type="datetime-local">` nativos:
 * o valor que o browser lê e escreve nesses dois tipos JÁ É a forma ISO de
 * largura fixa que I5 exige ("YYYY-MM-DD" / "YYYY-MM-DDTHH:mm"), então não
 * existe conversão de formato aqui — só validação defensiva contra um
 * valor fora da forma antes de `commit()`.
 */
import type { CellEditContext, CellRenderContext } from "../../core/property-spec";
import { ISO_DATE_VALUE_PATTERN } from "./date-iso";
import { formatDateValuePtBr } from "./date-format-pt-br";
import type { DateConfig, DateFieldValue } from "./date-value";

/** DBS-010/011/012: o texto pt-BR por extenso. Vazio não é derrubado nem substituído por rótulo — a Tabela decide, na camada compartilhada, o que uma célula vazia mostra. */
export function DateCellValue({ value }: CellRenderContext<DateFieldValue, DateConfig>) {
  if (value === null) return null;
  return <span>{formatDateValuePtBr(value)}</span>;
}

/**
 * "YYYY-MM-DD" cabe tanto num `<input type="date">` quanto, truncado, no
 * início de um `<input type="datetime-local">` — mas o inverso não vale: um
 * valor só-dia gravado sob uma config anterior (I2/I5 permitem a mesma
 * propriedade misturar formas) não é reconhecido por um `datetime-local` se
 * passado como está. Completar com meia-noite deixa o `<input>` mostrar a
 * data guardada em vez de aparecer vazio por incompatibilidade de largura.
 */
function toInputValue(iso: string, includeTime: boolean): string {
  if (!includeTime) return iso.slice(0, 10);
  return iso.length > 10 ? iso : `${iso}T00:00`;
}

export function DateCellEditor({ value, property, commit, close }: CellEditContext<DateFieldValue, DateConfig>) {
  const config = property.config;
  const inputType = config.includeTime ? "datetime-local" : "date";
  const draftStart = value ? toInputValue(value.start, config.includeTime) : "";
  const draftEnd = value?.end ? toInputValue(value.end, config.includeTime) : "";

  function commitStart(next: string) {
    if (next.length === 0) {
      commit(null);
      return;
    }
    // O `<input>` nativo já restringe a forma; um valor que ainda assim
    // escapar (extensão de navegador, autofill malformado) simplesmente não
    // é commitado — a célula continua com o valor anterior em vez de gravar
    // lixo que o Postgres rejeitaria com `chk_drv_iso_date_shape`.
    if (!ISO_DATE_VALUE_PATTERN.test(next)) return;
    commit(value?.end ? { start: next, end: value.end } : { start: next });
  }

  function commitEnd(next: string) {
    if (!value) return; // não há "fim" sem "início" — o segundo input só aparece com o primeiro preenchido.
    if (next.length === 0) {
      commit({ start: value.start });
      return;
    }
    if (!ISO_DATE_VALUE_PATTERN.test(next)) return;
    commit({ start: value.start, end: next });
  }

  return (
    <div className="flex items-center gap-2 p-1">
      <input
        type={inputType}
        aria-label={config.hasEnd ? "Início" : "Data"}
        value={draftStart}
        onChange={(event) => commitStart(event.target.value)}
        onBlur={close}
        // Célula abre em modo de edição já com o foco dentro, como qualquer outro editor inline desta grade — sem isto o usuário teria que clicar de novo dentro do próprio input que acabou de abrir.
        autoFocus
        className="rounded border border-surface-sunken bg-surface px-1 text-sm text-ink"
      />
      {config.hasEnd ? (
        <>
          <span aria-hidden="true" className="text-ink-muted">
            →
          </span>
          <input
            type={inputType}
            aria-label="Fim"
            value={draftEnd}
            onChange={(event) => commitEnd(event.target.value)}
            onBlur={close}
            disabled={value === null}
            className="rounded border border-surface-sunken bg-surface px-1 text-sm text-ink disabled:opacity-50"
          />
        </>
      ) : null}
    </div>
  );
}
