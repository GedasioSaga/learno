import type { CardRating, CardRow } from "../../lib/ipc";

/**
 * Estimativa client-side de quando um cartão volta, usada só para rotular os
 * quatro botões de resposta ANTES de o usuário responder — é o que torna a
 * escolha informada (o mesmo que o Anki mostra: "Errei → 10 min", "Bom → 3
 * dias"). O contrato de IPC não tem um comando de "pré-visualizar
 * agendamento"; `answerCard` só devolve o resultado DEPOIS de já ter gravado.
 *
 * Por isso este número é sempre uma aproximação, nunca a fonte de verdade: o
 * agendamento real é decidido pelo backend em `answerCard`, com sua própria
 * régua de SM-2 (ou FSRS, que nem segue uma fórmula fixa — calcula por curva
 * de retenção). Esta função replica só a metade "de senso comum" do SM-2
 * (fator de facilidade sobre o intervalo atual) para produzir um número
 * plausível; ela nunca é enviada a lugar nenhum nem persiste nada. Se o
 * número mostrado aqui divergir um pouco do que o backend realmente agenda,
 * o produto não quebra — só o rótulo do botão estava um pouco impreciso.
 */
export function preverIntervaloDias(
  card: Pick<CardRow, "state" | "intervalDays" | "easeFactor">,
  rating: CardRating,
): number {
  const emAprendizado = card.state === "new" || card.state === "learning" || card.state === "relearning";

  if (emAprendizado) {
    // Passos fixos de aprendizado, no padrão do Anki (1 min / 10 min), com
    // "Fácil" graduando direto para o intervalo inicial de revisão (4 dias).
    // Não temos acesso à configuração real de passos do baralho pelo
    // contrato — é a mesma aproximação "de senso comum" citada acima.
    const porResposta: Record<CardRating, number> = {
      again: 1 / (24 * 60),
      hard: 6 / (24 * 60),
      good: 10 / (24 * 60),
      easy: 4,
    };
    return porResposta[rating];
  }

  // Cartão em revisão: SM-2 clássico sobre o intervalo e o fator de
  // facilidade atuais. `easeFactor` vem inteiro (`CardRow.easeFactor` em
  // `lib/ipc.ts`: "2500 = 2.50", ou seja ÷1000 — o comentário de lá diz
  // "×100", mas o exemplo concreto que ele mesmo dá só fecha com ÷1000; um
  // cartão que nunca teve o fator setado chega como 0, e 2.5 é o padrão do
  // SM-2 nesse caso.
  const fatorFacil = card.easeFactor > 0 ? card.easeFactor / 1000 : 2.5;
  const base = Math.max(card.intervalDays, 1);
  const porResposta: Record<CardRating, number> = {
    again: 1 / (24 * 60), // errar uma revisão manda de volta para reaprendizagem
    hard: base * 1.2,
    good: base * fatorFacil,
    easy: base * fatorFacil * 1.3,
  };
  return porResposta[rating];
}

/** "10 min", "3 dias", "2 meses" — a partir de um número de dias fracionário (sempre > 0). */
export function formatarIntervalo(dias: number): string {
  const minutos = dias * 24 * 60;
  if (minutos < 60) {
    const arredondado = Math.max(1, Math.round(minutos));
    return `${arredondado} min`;
  }

  const horas = minutos / 60;
  if (horas < 24) {
    return `${Math.round(horas)} h`;
  }

  const diasInteiros = Math.round(dias);
  if (diasInteiros < 30) {
    return `${diasInteiros} dia${diasInteiros === 1 ? "" : "s"}`;
  }

  const meses = Math.round(diasInteiros / 30);
  if (meses < 12) {
    return `${meses} ${meses === 1 ? "mês" : "meses"}`;
  }

  const anos = Math.round(diasInteiros / 365);
  return `${anos} ${anos === 1 ? "ano" : "anos"}`;
}

/** Atalho: o texto pronto para o rótulo do botão de resposta. */
export function rotuloDeResposta(
  card: Pick<CardRow, "state" | "intervalDays" | "easeFactor">,
  rating: CardRating,
): string {
  return formatarIntervalo(preverIntervaloDias(card, rating));
}
