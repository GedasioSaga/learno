/**
 * Datas do Cronograma, sempre em hora de parede LOCAL — nunca
 * `toISOString()`/`toJSON()`, que convertem para UTC primeiro e empurram a
 * data de quem estuda de noite para o dia seguinte perto da meia-noite.
 *
 * Mesma decisão de `formatFixedWidthIso`/`parseFixedWidthIso` em
 * `features/databases/properties/date/date-iso.ts` (usar os getters locais
 * de `Date`, nunca um parse/format que passe por UTC), reimplementada aqui
 * em vez de importada de lá: aquele parser cobre também hora (`THH:mm`) e é
 * o mecanismo da Trilha/Calendário — o comentário de topo daquele arquivo já
 * marca a Trilha e o `@remind` como mecanismos distintos que não o
 * compartilham; o Cronograma é um terceiro, com uma pergunta mais simples
 * (só dia, nunca hora) e sem struct compartilhado para justificar o
 * acoplamento entre features.
 */

function pad2(valor: number): string {
  return String(valor).padStart(2, "0");
}

/** `YYYY-MM-DD` a partir de um `Date`, usando os getters LOCAIS — nunca `toISOString()`. */
export function formatarDataLocal(data: Date): string {
  return `${data.getFullYear()}-${pad2(data.getMonth() + 1)}-${pad2(data.getDate())}`;
}

/** O `YYYY-MM-DD` de hoje, no fuso local do computador — não UTC. */
export function hojeLocal(agora: Date = new Date()): string {
  return formatarDataLocal(agora);
}

/** `YYYY-MM-DD` -> `Date` à meia-noite LOCAL. Nunca `new Date(iso)`: esse construtor interpreta `"YYYY-MM-DD"` como UTC. */
function parseDataLocal(dataIso: string): Date {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  return new Date(ano, mes - 1, dia);
}

/** Soma (ou subtrai, com `dias` negativo) dias de calendário a uma data `YYYY-MM-DD` local. */
export function somarDiasLocal(dataIso: string, dias: number): string {
  const data = parseDataLocal(dataIso);
  data.setDate(data.getDate() + dias);
  return formatarDataLocal(data);
}

/**
 * A segunda-feira da semana que contém `data` (hoje, se omitida), local.
 * `getDay()` é `0` para domingo — o deslocamento `(diaDaSemana + 6) % 7`
 * conta quantos dias já se passaram desde a última segunda, incluindo o
 * caso domingo (6 dias depois da segunda anterior).
 */
export function inicioDaSemanaLocal(data: Date = new Date()): string {
  const diaDaSemana = data.getDay();
  const deslocamento = (diaDaSemana + 6) % 7;
  const segunda = new Date(data.getFullYear(), data.getMonth(), data.getDate() - deslocamento);
  return formatarDataLocal(segunda);
}

const ABREVIACOES_DO_DIA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

/** "seg", "ter"… a partir de um `YYYY-MM-DD` local. */
export function abreviacaoDoDia(dataIso: string): string {
  return ABREVIACOES_DO_DIA[parseDataLocal(dataIso).getDay()];
}

/** "5 de set." a partir de um `YYYY-MM-DD` local — mesmo locale pt-BR do resto do app. */
export function rotuloCurtoDoDia(dataIso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(parseDataLocal(dataIso));
}
