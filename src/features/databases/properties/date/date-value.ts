/**
 * A forma em memória (`DateValue`, já declarada em `contract.ts`) e as
 * operações que `PropertySpec<DateFieldValue, DateConfig>` (`date-spec.ts`)
 * precisa: vazio (I1), canonização de escrita, parse total, texto puro
 * determinístico e a chave de ordenação (I2). Separado de `date-spec.ts`
 * para que estas funções sejam testáveis sem importar `PropertySpec` nem
 * React — o mesmo corte que `formatNumberValue` faz em `number-spec.ts`.
 */
import type { DateValue } from "../../contract";
import { ISO_DATE_VALUE_PATTERN } from "./date-iso";

/**
 * `TValue` do spec. `null` é a representação em memória do vazio (célula
 * sem linha em `database_record_values`) — o mesmo papel que `NumberValue =
 * number | null` cumpre para Número.
 */
export type DateFieldValue = DateValue | null;

/** I5: `includeTime`/`hasEnd` moram aqui, nunca no valor — ver `contract.ts`. */
export interface DateConfig {
  /** Mostra hora além do dia. Não reescreve valores já gravados sozinha —
   *  é o `<input>` do editor que passa a incluir `THH:MM` na próxima edição. */
  includeTime: boolean;
  /** Habilita o segundo seletor (fim do intervalo) no editor. Um registro
   *  pode ter `end` mesmo com isto desligado, e vice-versa — o valor de
   *  CADA linha manda, nunca a config (I2; ver o teste "formas misturadas"
   *  em `date-value.test.ts`). */
  hasEnd: boolean;
}

export const DEFAULT_DATE_CONFIG: DateConfig = { includeTime: false, hasEnd: false };

/**
 * Único ponto de `as` deste arquivo: o `typeof value === "object" && value
 * !== null` acima já prova, em runtime, que é seguro indexar por string —
 * TypeScript não estreita `object` para permitir acesso a propriedade sem
 * esta anotação. Reaproveitado por `isEmptyDateValue` e `parseDateValue`
 * para não duplicar o cast.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * I1 aplicada a Data: o único jeito de um valor ser vazio é não ter sequer
 * um `start` na forma ISO de largura fixa. Funciona tanto sobre o jsonb cru
 * (o que a fronteira de consulta pode chamar diretamente) quanto sobre um
 * `DateFieldValue` já `parse()`ado — as duas formas compartilham o mesmo
 * shape, então a mesma checagem serve para as duas.
 */
export function isEmptyDateValue(value: unknown): boolean {
  const record = asRecord(value);
  if (record === null) return true;
  const start = record.start;
  return typeof start !== "string" || !ISO_DATE_VALUE_PATTERN.test(start);
}

/**
 * jsonb -> `DateFieldValue`. TOTAL (nunca lança): um `value` corrompido, ou
 * sem `start` válido, devolve `null` — o mesmo vazio que a ausência da
 * linha já significa (I1). Um `end` fora da forma é descartado sozinho
 * (mantém só o `start`) em vez de derrubar o registro inteiro — uma célula
 * não pode sumir da Tabela por causa do lado errado do intervalo.
 */
export function parseDateValue(raw: unknown): DateFieldValue {
  const record = asRecord(raw);
  if (record === null) return null;
  const start = record.start;
  if (typeof start !== "string" || !ISO_DATE_VALUE_PATTERN.test(start)) return null;
  const end = record.end;
  if (typeof end === "string" && ISO_DATE_VALUE_PATTERN.test(end)) return { start, end };
  return { start };
}

/**
 * Canoniza antes de gravar (I4/I1). `null` apaga a linha — é o que impede
 * um `start` fora da forma de chegar ao Postgres: sem isto, o usuário veria
 * o erro cru de `chk_drv_iso_date_shape` em vez de a célula simplesmente
 * ficar vazia. Idêntica a `parseDateValue` de propósito (a config não muda
 * o que é canônico para Data, só como ele é exibido — o mesmo raciocínio de
 * `NumberConfig.format` em `number-spec.ts`).
 */
export function normalizeDateValue(value: unknown): DateFieldValue {
  return parseDateValue(value);
}

/**
 * Determinística, sem locale (arquitetura §6) — é o que
 * `src-tauri/tests/fixtures/property_values.json` (casos `date_*`) e o
 * espelho Rust em `record_values.rs` verificam byte a byte. NUNCA a
 * formatação pt-BR de `date-format-pt-br.ts`, que é só para a tela. A
 * escolha de mostrar o intervalo olha `value.end`, nunca `config.hasEnd` —
 * a mesma database pode ter registros com e sem `end` ao mesmo tempo.
 */
export function toPlainTextDateValue(value: DateFieldValue): string {
  if (value === null) return "";
  return typeof value.end === "string" && value.end.length > 0 ? `${value.start} – ${value.end}` : value.start;
}

/**
 * A chave de ordenação que espelha a coluna gerada `sort_text`
 * (`docs/FASE-3-SCHEMA.sql`: `value ->> 'start'`) — NUNCA ordene por
 * `JSON.stringify(value)` nem pelo objeto inteiro (I2): um intervalo tem
 * mais chaves que uma data solta, e comparar por chave (o que o jsonb do
 * Postgres faz em `ORDER BY value`) prende um registro de início mais cedo
 * atrás de um de início mais tarde só porque o primeiro também tem `end`.
 * Ver `date-value.test.ts`, seção I2, para o par que prova isso na prática.
 */
export function dateSortKey(value: DateValue): string {
  return value.start;
}
