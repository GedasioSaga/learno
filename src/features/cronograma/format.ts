import type { AtividadeDoBloco, BlocoPlanejado } from "../../lib/ipc";

/** Rótulo em português de cada atividade — decisão deste arquivo; a CHAVE é o valor que atravessa o fio (`AtividadeDoBloco`, inglês), o VALOR é só o que o usuário lê. */
export const ROTULO_DA_ATIVIDADE: Record<AtividadeDoBloco, string> = {
  pomodoro: "Pomodoro",
  review: "Revisão",
  mindmap: "Mapa mental",
  reading: "Leitura",
  other: "Outro",
};

/** "6,5" a partir de 390 minutos — mesma formatação pt-BR (vírgula decimal) de `number-spec.ts` em `features/databases`. */
export function minutosParaHorasTexto(minutos: number): string {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(minutos / 60);
}

/**
 * O que aparece no cartão do bloco: "2×25 min" quando é pomodoro com ciclos
 * conhecidos (o "2x25" da maquete), ou só a duração nos outros casos —
 * `pomodoroCycles` não vem preenchido na criação (`criarBloco` não recebe
 * esse campo; ele viria de um `atualizarBloco` posterior, que esta rodada da
 * UI ainda não liga — ver o relatório de entrega do `ConteudoDeCronograma`).
 */
export function formatarDuracao(
  bloco: Pick<BlocoPlanejado, "activity" | "plannedMinutes" | "pomodoroCycles">,
): string {
  if (bloco.activity === "pomodoro" && bloco.pomodoroCycles !== null && bloco.pomodoroCycles > 0) {
    const minutosPorCiclo = Math.round(bloco.plannedMinutes / bloco.pomodoroCycles);
    return `${bloco.pomodoroCycles}×${minutosPorCiclo} min`;
  }
  return `${bloco.plannedMinutes} min`;
}

/**
 * O texto que identifica um bloco pro usuário: o título livre quando existe,
 * senão o rótulo em português da atividade. Era lógica inline de `BlocoCard`
 * (`bloco.title?.trim() ? ... : ROTULO_DA_ATIVIDADE[...]`); extraída pra cá
 * porque a grade (`grade.ts` monta a célula, `cores.ts` decide a cor a
 * partir do MESMO texto) também precisa dela — duplicar a regra arriscava
 * cartão e célula da grade mostrarem rótulos diferentes pro mesmo bloco, ou
 * a cor mudar de um jeito que o texto não explica.
 */
export function rotuloDoBloco(bloco: Pick<BlocoPlanejado, "title" | "activity">): string {
  const titulo = bloco.title?.trim();
  return titulo ? titulo : ROTULO_DA_ATIVIDADE[bloco.activity];
}
