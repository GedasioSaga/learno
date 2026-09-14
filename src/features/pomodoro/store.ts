import { create } from "zustand";
import { AppError, finishPomodoro, startPomodoro, type PomodoroKind } from "../../lib/ipc";

/**
 * Duração de cada fase, em segundos. Padrão clássico do método Pomodoro — 25
 * min de foco, 5 min de pausa curta, 15 min de pausa longa a cada 4 focos.
 * O contrato de IPC não fixa duração nenhuma (`startPomodoro(kind,
 * durationSeconds)` recebe o segundo argumento pronto); esta tabela é
 * decisão deste arquivo.
 */
export const DURACAO_SEGUNDOS: Record<PomodoroKind, number> = {
  focus: 25 * 60,
  short_break: 5 * 60,
  long_break: 15 * 60,
};

/** Depois de quantos focos completos vem a pausa longa. */
export const FOCUS_SESSIONS_BEFORE_LONG_BREAK = 4;

export type StatusPomodoro = "idle" | "executando" | "pausado";

/** O bloco do cronograma que um foco executa: o id vai ao backend, o rótulo só aparece na tela. */
export interface BlocoAlvo {
  id: string;
  rotulo: string;
}

interface EstadoPomodoro {
  fase: PomodoroKind;
  status: StatusPomodoro;
  /**
   * 1..`FOCUS_SESSIONS_BEFORE_LONG_BREAK` — o foco atual (durante um foco) ou
   * o próximo (durante a pausa que o segue). Só uma fase de FOCO concluída
   * muda este número; uma pausa concluída nunca mexe nele.
   */
  focusNumeroNoCiclo: number;
  /** Instante (epoch ms) em que a fase corrente termina. `null` fora de `executando`. */
  terminaEm: number | null;
  /** Segundos que restavam quando a fase foi pausada. `null` fora de `pausado`. */
  restantesAoPausar: number | null;
  /** Sessão aberta no backend por `startPomodoro`. `null` em `idle`. */
  sessionId: string | null;
  erro: string | null;
  /**
   * O bloco que os próximos FOCOS executam ("Focar neste bloco"). Continua
   * escolhido entre um foco e outro, porque um bloco de 50 minutos pede dois,
   * até alguém desvincular. A pausa do meio nunca é ligada a ele.
   */
  blocoAlvo: BlocoAlvo | null;

  /** Quantos segundos faltam AGORA — calculado contra o relógio (`Date.now()`), nunca contra uma contagem de tiques. */
  segundosRestantes: () => number;
  iniciar: () => Promise<void>;
  pausar: () => void;
  reiniciar: () => Promise<void>;
  /**
   * Chamado pelo tique da UI (a cada ~1s enquanto `executando`); só faz algo
   * quando o relógio já passou do fim da fase. É aqui que um salto de
   * relógio (laptop suspenso, aba estrangulada pelo WebView2) é absorvido de
   * uma vez só, em vez de exigir um tique por segundo perdido — o defeito
   * clássico de medir tempo contando quantas vezes um `setInterval` disparou.
   */
  verificarFimDaFase: () => void;
  /** Escolhe o bloco e já inicia o foco ligado a ele. Recusado com um pomodoro em andamento. */
  focarNoBloco: (bloco: BlocoAlvo) => Promise<void>;
  /** Tira o bloco escolhido. Só vale com o cronômetro parado: a sessão em andamento já está ligada a ele. */
  desvincularBloco: () => void;
}

function mensagemDoErro(erro: unknown, resposta: string): string {
  return erro instanceof AppError ? erro.message : resposta;
}

/**
 * Decide a fase e o número de foco seguintes a partir da fase que acabou de
 * terminar. Função pura, sem `set`/`get` — existe separada do corpo da store
 * para a progressão do ciclo (foco → pausa curta → foco → … → foco 4 →
 * pausa longa → foco 1 de novo) poder ser testada sem depender do resto do
 * timer.
 */
export function calcularProximaFase(
  faseConcluida: PomodoroKind,
  focusNumeroAtual: number,
): { proximaFase: PomodoroKind; proximoFocusNumero: number } {
  if (faseConcluida !== "focus") {
    // Depois de qualquer pausa começa um foco novo; o número já foi ajustado
    // quando o FOCO anterior terminou (ramo abaixo) — a pausa em si nunca
    // mexe nele.
    return { proximaFase: "focus", proximoFocusNumero: focusNumeroAtual };
  }
  const eraOUltimoDoCiclo = focusNumeroAtual >= FOCUS_SESSIONS_BEFORE_LONG_BREAK;
  return {
    proximaFase: eraOUltimoDoCiclo ? "long_break" : "short_break",
    proximoFocusNumero: eraOUltimoDoCiclo ? 1 : focusNumeroAtual + 1,
  };
}

/**
 * O timer do Pomodoro.
 *
 * Decisão sobre fechar e reabrir o app no meio de um foco: este store não
 * persiste nada (nem `localStorage`, nem `config.json`) — é memória pura, e
 * fechar o processo do Tauri a apaga como qualquer outro estado do React. Ao
 * reabrir, a tela volta a `idle` na duração cheia do foco, com o ciclo
 * zerado em 1. A sessão que `startPomodoro` tinha aberto no backend fica sem
 * `finishPomodoro` — um registro honesto de que aquele foco realmente não
 * terminou, e não um dado inventado dizendo que terminou (`completed: true`)
 * nem uma tentativa de adivinhar, na reabertura, se ela deveria continuar de
 * onde parou. Persistir o timer para sobreviver ao fechamento é possível
 * (o mesmo padrão de `terminaEm` já calculado contra o relógio funcionaria),
 * mas fica fora desta rodada: o contrato de IPC não tem um jeito de
 * "abandonar" uma sessão aberta, então reabrir com `sessionId` recuperado e
 * decidir sozinho se ela expirou enquanto o app estava fechado é uma
 * máquina de estados nova que ninguém pediu ainda.
 *
 * Decisão sobre o fim automático de uma fase: quando o relógio chega a zero
 * sozinho, a fase seguinte já aparece selecionada (a pausa que corresponde,
 * ou o próximo foco) mas PARADA em `idle` — o app nunca começa a contar uma
 * pausa de 15 minutos, ou um foco novo, sem a pessoa apertar Iniciar. Sem som
 * nem notificação nesta rodada, tocar a fase seguinte sozinho seria fácil de
 * não perceber.
 */
export const usePomodoroStore = create<EstadoPomodoro>((set, get) => {
  async function concluirFase(faseConcluida: PomodoroKind, sessionIdConcluido: string | null): Promise<void> {
    // completed: true — o relógio de parede confirma que o tempo total
    // passou. É o oposto de `reiniciar`, que fecha a sessão como abandonada.
    if (sessionIdConcluido) {
      try {
        await finishPomodoro(sessionIdConcluido, true);
      } catch (erro) {
        set({ erro: mensagemDoErro(erro, "Não foi possível registrar o fim do pomodoro.") });
      }
    }
    const { proximaFase, proximoFocusNumero } = calcularProximaFase(faseConcluida, get().focusNumeroNoCiclo);
    set({ fase: proximaFase, focusNumeroNoCiclo: proximoFocusNumero, status: "idle" });
  }

  return {
    fase: "focus",
    status: "idle",
    focusNumeroNoCiclo: 1,
    terminaEm: null,
    restantesAoPausar: null,
    sessionId: null,
    erro: null,
    blocoAlvo: null,

    segundosRestantes: () => {
      const estado = get();
      if (estado.status === "pausado") return estado.restantesAoPausar ?? 0;
      if (estado.status !== "executando" || estado.terminaEm === null) return DURACAO_SEGUNDOS[estado.fase];
      return Math.max(0, Math.ceil((estado.terminaEm - Date.now()) / 1000));
    },

    iniciar: async () => {
      const estado = get();
      if (estado.status === "executando") return;

      if (estado.status === "pausado") {
        // Retomar não abre sessão nova — é a mesma sessão continuando; só o
        // instante de término é recalculado contra o relógio atual.
        const restantes = estado.restantesAoPausar ?? DURACAO_SEGUNDOS[estado.fase];
        set({ status: "executando", terminaEm: Date.now() + restantes * 1000, restantesAoPausar: null, erro: null });
        return;
      }

      const duracao = DURACAO_SEGUNDOS[estado.fase];
      const bloco = estado.fase === "focus" ? estado.blocoAlvo : null;
      try {
        const sessao = bloco
          ? await startPomodoro(estado.fase, duracao, bloco.id)
          : await startPomodoro(estado.fase, duracao);
        set({ status: "executando", sessionId: sessao.id, terminaEm: Date.now() + duracao * 1000, erro: null });
      } catch (erro) {
        set({ erro: mensagemDoErro(erro, "Não foi possível iniciar o pomodoro.") });
      }
    },

    pausar: () => {
      const estado = get();
      if (estado.status !== "executando" || estado.terminaEm === null) return;
      const restantes = Math.max(0, Math.ceil((estado.terminaEm - Date.now()) / 1000));
      set({ status: "pausado", restantesAoPausar: restantes, terminaEm: null });
    },

    reiniciar: async () => {
      const estado = get();
      const sessionIdAntigo = estado.sessionId;
      // Reseta a UI na hora — "Reiniciar" não deve esperar um round-trip de
      // IPC para o cronômetro voltar à duração cheia. A limpeza da sessão
      // antiga no backend acontece depois, em segundo plano.
      set({ status: "idle", terminaEm: null, restantesAoPausar: null, sessionId: null, erro: null });
      if (sessionIdAntigo) {
        try {
          // completed: false — foi a pessoa que desistiu no meio, não o
          // relógio que chegou a zero.
          await finishPomodoro(sessionIdAntigo, false);
        } catch (erro) {
          set({ erro: mensagemDoErro(erro, "Não foi possível registrar a interrupção do pomodoro.") });
        }
      }
    },

    verificarFimDaFase: () => {
      const estado = get();
      if (estado.status !== "executando" || estado.terminaEm === null) return;
      if (Date.now() < estado.terminaEm) return;

      const faseConcluida = estado.fase;
      const sessionIdConcluido = estado.sessionId;
      // Trava novas checagens re-entrantes (o próximo tique, ~1s depois)
      // enquanto a transição assíncrona (`finishPomodoro` + o `set` de
      // `concluirFase`) ainda não terminou — sem isto, dois tiques seguidos
      // chamariam `finishPomodoro` duas vezes para a mesma sessão.
      set({ status: "idle", terminaEm: null, sessionId: null });
      void concluirFase(faseConcluida, sessionIdConcluido);
    },

    focarNoBloco: async (bloco) => {
      const estado = get();
      if (estado.status !== "idle") {
        if (estado.blocoAlvo?.id === bloco.id) return;
        set({ erro: "Reinicie o pomodoro em andamento antes de focar em outro bloco." });
        return;
      }
      set({ fase: "focus", blocoAlvo: bloco, erro: null });
      await get().iniciar();
    },

    desvincularBloco: () => {
      if (get().status === "idle") set({ blocoAlvo: null });
    },
  };
});
