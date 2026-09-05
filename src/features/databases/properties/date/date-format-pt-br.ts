/**
 * A formatação pt-BR de exibição — DBS-010 ("15 de março de 2026"), DBS-011
 * ("1 → 5 de março") e DBS-012 (mostra a hora). Só para a TELA: nunca usada
 * por `toPlainTextDateValue` (CSV/busca/fixture), que precisa ficar
 * determinística e sem locale variável (arquitetura §6).
 */
import type { DateValue } from "../../contract";
import { parseFixedWidthIso, type ParsedFixedWidthIso } from "./date-iso";

const MONTH_NAMES_PT_BR: readonly string[] = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatSingle(parsed: ParsedFixedWidthIso): string {
  const { date, hasTime } = parsed;
  const long = `${date.getDate()} de ${MONTH_NAMES_PT_BR[date.getMonth()]} de ${date.getFullYear()}`;
  return hasTime ? `${long} às ${pad2(date.getHours())}:${pad2(date.getMinutes())}` : long;
}

/**
 * DBS-011, literal do critério: "1 → 5 de março" quando início e fim caem
 * no mesmo mês/ano e nenhum lado carrega hora. Fora disso (mês diferente,
 * ano diferente, ou qualquer lado com hora) não há exemplo exato no
 * checklist para validar contra — a decisão aqui é escrever cada lado por
 * extenso (com `formatSingle`) e ligar por "→", em vez de inventar uma
 * segunda forma compacta sem critério que a comprove.
 */
function formatRange(start: ParsedFixedWidthIso, end: ParsedFixedWidthIso): string {
  const sameMonth = start.date.getFullYear() === end.date.getFullYear() && start.date.getMonth() === end.date.getMonth();
  const eitherHasTime = start.hasTime || end.hasTime;
  if (sameMonth && !eitherHasTime) {
    return `${start.date.getDate()} → ${end.date.getDate()} de ${MONTH_NAMES_PT_BR[start.date.getMonth()]}`;
  }
  return `${formatSingle(start)} → ${formatSingle(end)}`;
}

/**
 * O texto que a célula mostra (DBS-010/011/012). TOTAL: um `start`
 * corrompido devolve `""` em vez de lançar — uma célula de Data não pode
 * derrubar a Tabela. Um `end` corrompido degrada para mostrar só o início,
 * em vez de esconder a linha inteira.
 */
export function formatDateValuePtBr(value: DateValue): string {
  const start = parseFixedWidthIso(value.start);
  if (!start) return "";
  if (typeof value.end !== "string" || value.end.length === 0) return formatSingle(start);
  const end = parseFixedWidthIso(value.end);
  if (!end) return formatSingle(start);
  return formatRange(start, end);
}
