/**
 * O parser/serializador ISO de largura fixa (I5) — a peça que a Trilha
 * (Timeline) e o Calendário PRECISAM importar em vez de reescrever: um
 * segundo parser de data divergindo do primeiro é exatamente o tipo de bug
 * que `docs/ACHADOS-FASE-2.md` documenta duas vezes (o autosave e os input
 * rules markdown). Mora aqui, ao lado do spec de "date", porque é o MESMO
 * formato que `chk_drv_iso_date_shape` (`docs/FASE-3-SCHEMA.sql`) impõe no
 * banco — mudar um dos dois sem o outro faz o cliente aceitar um valor que
 * o Postgres rejeita na escrita.
 *
 * Fora daqui: `src/features/editor/marks/mention-date/date-parsing.ts` é um
 * mecanismo DIFERENTE (EDT-045/048, `@remind` em texto comum) com um valor
 * sempre só-dia e sem intervalo — não compartilha este parser de propósito,
 * mesmo formatando datas parecidas (ver checklist EDT-086, que nomeia os
 * dois mecanismos como distintos).
 */

/**
 * Espelha `chk_drv_iso_date_shape` (`docs/FASE-3-SCHEMA.sql`) caractere por
 * caractere. Mudar aqui sem mudar lá (ou vice-versa) faz o cliente aceitar
 * um valor que o Postgres rejeita: a escrita chegaria a I4, o CHECK
 * dispararia, e o usuário veria um erro de SQL cru em vez de uma validação
 * de formulário.
 */
export const ISO_DATE_VALUE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2}))?$/;

export interface ParsedFixedWidthIso {
  /** Local de parede (I5) — nunca UTC. Meia-noite quando `hasTime` é `false`. */
  date: Date;
  /** `true` quando o texto de origem carregava `THH:MM`. Deriva da FORMA do
   *  texto, nunca de `config.includeTime`: a mesma propriedade pode ter
   *  registros gravados sob uma config anterior, e confiar na config em vez
   *  do valor faria a tela mentir sobre um dado que o banco guarda certo. */
  hasTime: boolean;
}

/**
 * TOTAL: nunca lança. Um texto fora da forma, ou uma data de calendário que
 * não existe ("2026-02-30", que `Date` normalizaria em silêncio para 2 de
 * março), devolve `null` em vez de um `Date` incorreto — a mesma defesa que
 * `parseIsoDateString` já usa no mecanismo de `@remind`.
 */
export function parseFixedWidthIso(text: string): ParsedFixedWidthIso | null {
  const match = ISO_DATE_VALUE_PATTERN.exec(text);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hasTime = hourText !== undefined;
  const hour = hasTime ? Number(hourText) : 0;
  const minute = hasTime ? Number(minuteText) : 0;
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { date, hasTime };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * O inverso de `parseFixedWidthIso` — o que a Trilha usa para escrever de
 * volta uma data arrastada, e o que `date-cell.tsx` usa para exibir o valor
 * armazenado num `<input>` nativo. Local de parede, largura fixa,
 * zero-padding (I5) — nunca `toISOString()`, que converteria para UTC
 * primeiro e deslocaria o dia perto da meia-noite.
 */
export function formatFixedWidthIso(date: Date, includeTime: boolean): string {
  const base = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return includeTime ? `${base}T${pad2(date.getHours())}:${pad2(date.getMinutes())}` : base;
}
