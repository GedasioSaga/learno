/**
 * I5 aplicada ao instante bruto de `pages.created_at`/`pages.updated_at`
 * (TIMESTAMPTZ; chega do Rust como string RFC3339, `chrono::DateTime<Utc>`
 * serializado) — a metade pura e testável do que
 * `timestamp-spec.ts` (`created_time`/`last_edited_time`) precisa. Nenhuma
 * função aqui toca `PropertySpec`, `React` nem `RecordRow`: só a conversão
 * "instante -> hora local de parede" e "hora local de parede -> texto".
 *
 * Arquitetura §6: `created_time`/`last_edited_time` NÃO têm linha em
 * `database_record_values` — o valor nasce projetado direto da coluna de
 * `pages`, nunca de jsonb gravado. Por isso este arquivo nunca lê `config`
 * para decidir O QUE guardar (só `PropertySpec.normalize`, que aqui sempre
 * devolve `null`, teria esse papel) — `TimestampConfig.includeTime` decide
 * só o que aparece na tela/no texto puro, nunca o que seria persistido.
 */
import type { DateValue } from "../../contract";

/** Config de uma propriedade `created_time`/`last_edited_time`. Sem `hasEnd`: um instante único nunca é um intervalo. */
export interface TimestampConfig {
  /** Mostra "HH:mm" além da data em `renderValue`/`toPlainText`. O valor internamente SEMPRE guarda os dois — isto é só uma decisão de exibição. */
  includeTime: boolean;
}

export const DEFAULT_TIMESTAMP_CONFIG: TimestampConfig = { includeTime: true };

/**
 * Sentinela de "instante corrompido" — na prática nunca deveria acontecer
 * (`pages.created_at`/`updated_at` são `NOT NULL` no schema), mas
 * `PropertySpec.parse` é TOTAL por contrato (`core/property-spec.ts`):
 * nunca lança, mesmo com entrada impossível. `start: ""` nunca colide com
 * uma data real (I5 exige `YYYY-MM-DD` no mínimo).
 */
const CORRUPTED_INSTANT: DateValue = { start: "" };

export function isCorruptedTimestampValue(value: DateValue): boolean {
  return value.start === "";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * `instant` (RFC3339, qualquer fuso) -> `DateValue` de I5 na hora LOCAL de
 * parede da máquina do usuário (o app é local, sem servidor — arquitetura
 * §6, nota de `PersonValue`). Lê os campos de `Date` (`getFullYear`,...),
 * nunca `toISOString()`: aquele converte para UTC primeiro, que é
 * precisamente o bug que desloca o dia perto da meia-noite em fusos a oeste
 * de UTC (mesma armadilha documentada em
 * `editor/marks/mention-date/date-parsing.ts`).
 *
 * SEMPRE inclui a hora (largura `YYYY-MM-DDTHH:mm`) — `TimestampConfig` não
 * chega até aqui (`PropertySpec.parse` não recebe `config`, ao contrário de
 * `normalize`/`isEmpty`/`toPlainText`); truncar para só a data é decisão de
 * exibição, feita por `formatTimestampPlainText`/quem renderiza a célula.
 */
export function parseInstantToLocalDateValue(instant: unknown): DateValue {
  if (typeof instant !== "string" || instant.trim() === "") return CORRUPTED_INSTANT;
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return CORRUPTED_INSTANT;
  const start =
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return { start };
}

/** "YYYY-MM-DDTHH:mm" -> só "YYYY-MM-DD". Recorte de string, não um segundo `Date`/parse — reprocessar reintroduziria fuso onde já não há nenhum a resolver. */
function dateOnlyPart(start: string): string {
  return start.slice(0, 10);
}

/**
 * "DD/MM/AAAA" ou "DD/MM/AAAA HH:mm", conforme `config.includeTime`.
 * Recorte puro de string sobre um ISO já de largura fixa (I5) —
 * deliberadamente sem `Intl`/nome de mês por locale (isso variaria por ICU
 * instalado): é o texto puro que alimenta CSV/busca/o fixture de
 * conformidade (arquitetura §10), e esse eixo exige determinismo, não
 * fidelidade a um formato de exibição regional.
 */
export function formatTimestampPlainText(value: DateValue, config: TimestampConfig): string {
  if (isCorruptedTimestampValue(value)) return "";
  const [year, month, day] = dateOnlyPart(value.start).split("-");
  const ddmmyyyy = `${day}/${month}/${year}`;
  const timePart = value.start.slice(11, 16); // "HH:mm", "" quando ausente
  return config.includeTime && timePart !== "" ? `${ddmmyyyy} ${timePart}` : ddmmyyyy;
}
