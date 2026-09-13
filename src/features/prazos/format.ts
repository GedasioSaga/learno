import type { PrazoComContagem, PrazosListados } from "./ipc";

/**
 * O texto da contagem regressiva — SEMPRE o número exato que o backend
 * mandou (`diasRestantes`), nunca arredondado nem agrupado. É este texto,
 * não a cor nem o símbolo, que carrega o fato; `nivelDeUrgencia` só agrupa
 * visualmente o que este texto já diz (regra do projeto: nada na tela pode
 * depender só de cor).
 */
export function rotuloDeContagem(diasRestantes: number): string {
  if (diasRestantes === 0) return "Vence hoje";
  if (diasRestantes > 0) {
    return diasRestantes === 1 ? "Falta 1 dia" : `Faltam ${diasRestantes} dias`;
  }
  const dias = Math.abs(diasRestantes);
  return `Venceu há ${dias} dia${dias === 1 ? "" : "s"}`;
}

export type NivelDeUrgencia = "vencido" | "hoje" | "proximo" | "distante";

/**
 * Agrupamento visual por urgência. Limiares: vencido (`< 0`), hoje (`0`),
 * próximo (`1..=3`), distante (`4+`) — arbitrário, mas sempre acompanhado do
 * texto exato de `rotuloDeContagem`, nunca a única fonte da informação.
 */
export function nivelDeUrgencia(diasRestantes: number): NivelDeUrgencia {
  if (diasRestantes < 0) return "vencido";
  if (diasRestantes === 0) return "hoje";
  if (diasRestantes <= 3) return "proximo";
  return "distante";
}

/**
 * A FORMA que acompanha a cor de cada nível — símbolo ASCII simples (não
 * emoji: mesmo motivo de `icones.tsx` em `features/navegacao`, mas aqui não
 * precisa tingir com `currentColor`, então texto puro basta), para quem não
 * distingue cor ainda perceber a diferença.
 */
export const SIMBOLO_DE_URGENCIA: Record<NivelDeUrgencia, string> = {
  vencido: "▲",
  hoje: "●",
  proximo: "◐",
  distante: "○",
};

function parseDataLocal(dataIso: string): Date {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  return new Date(ano, mes - 1, dia);
}

/**
 * "20 de set. de 2026" a partir de `dueLocalDate` (`YYYY-MM-DD`) — mesmo
 * locale pt-BR e o mesmo cuidado de `cronograma/date-utils.ts`: nunca
 * `new Date(iso)` puro, que interpretaria a string como UTC e poderia
 * mostrar o dia errado perto da virada.
 */
export function formatarDataDoPrazo(dueLocalDate: string): string {
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", year: "numeric" }).format(
    parseDataLocal(dueLocalDate),
  );
}

/**
 * O prazo mais urgente de uma listagem — o que `CartaoDeProximoPrazo`
 * mostra na tela Hoje. Um vencido ainda ativo é MAIS urgente que qualquer
 * futuro (a prova já passou e ninguém marcou como concluída): por isso
 * `vencidos[0]` (o mais recente — já vem nessa ordem do backend) vence sobre
 * `futuros[0]`. `null` quando não há nenhum prazo ativo — nunca inventa um.
 */
export function escolherMaisUrgente(listagem: PrazosListados): PrazoComContagem | null {
  if (listagem.vencidos.length > 0) return listagem.vencidos[0];
  if (listagem.futuros.length > 0) return listagem.futuros[0];
  return null;
}
