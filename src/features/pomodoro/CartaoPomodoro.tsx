import { useEffect, useReducer } from "react";
import type { PomodoroKind } from "../../lib/ipc";
import { FOCUS_SESSIONS_BEFORE_LONG_BREAK, usePomodoroStore } from "./store";

function formatarTempo(segundosTotais: number): string {
  const minutos = Math.floor(segundosTotais / 60);
  const segundos = segundosTotais % 60;
  return `${String(minutos).padStart(2, "0")}:${String(segundos).padStart(2, "0")}`;
}

const ROTULO_DA_FASE: Record<PomodoroKind, (focusNumeroNoCiclo: number) => string> = {
  focus: (n) => `Agora — pomodoro ${n} de ${FOCUS_SESSIONS_BEFORE_LONG_BREAK}`,
  short_break: () => "Pausa curta",
  long_break: () => "Pausa longa",
};

/**
 * O cartão de Pomodoro da seção Hoje: Iniciar/Pausar/Reiniciar um foco de
 * verdade, contra o relógio de parede.
 *
 * A contagem em si não mora em nenhum estado de React: `usePomodoroStore`
 * guarda só o INSTANTE em que a fase termina (`terminaEm`), e
 * `segundosRestantes()` recalcula o que falta contra `Date.now()` toda vez
 * que é chamada. O `setInterval` abaixo não conta segundos — só força um
 * redesenho a cada tique e pergunta de novo ao store "quanto falta AGORA" e
 * "a fase já terminou". Se o WebView2 estrangular a aba em segundo plano e
 * pular vários segundos entre um tique e o próximo, o número mostrado no
 * tique seguinte continua certo, porque nunca dependeu de quantos tiques
 * aconteceram.
 */
export function CartaoPomodoro() {
  const fase = usePomodoroStore((state) => state.fase);
  const status = usePomodoroStore((state) => state.status);
  const focusNumeroNoCiclo = usePomodoroStore((state) => state.focusNumeroNoCiclo);
  const erro = usePomodoroStore((state) => state.erro);
  const iniciar = usePomodoroStore((state) => state.iniciar);
  const pausar = usePomodoroStore((state) => state.pausar);
  const reiniciar = usePomodoroStore((state) => state.reiniciar);

  // O tique só força um redesenho — o valor mostrado vem de
  // `segundosRestantes()`, lido de novo a cada render.
  const [, redesenhar] = useReducer((contador: number) => contador + 1, 0);

  useEffect(() => {
    if (status !== "executando") return;
    const idIntervalo = window.setInterval(() => {
      usePomodoroStore.getState().verificarFimDaFase();
      redesenhar();
    }, 1000);
    return () => window.clearInterval(idIntervalo);
  }, [status]);

  const segundosRestantes = usePomodoroStore.getState().segundosRestantes();
  const temSessaoParaReiniciar = status !== "idle";

  return (
    <section
      aria-labelledby="cartao-pomodoro-titulo"
      className="flex flex-col items-start rounded-md border border-border bg-surface p-6 shadow-hard-sm"
    >
      <h2 id="cartao-pomodoro-titulo" className="text-sm font-medium text-ink-muted">
        {ROTULO_DA_FASE[fase](focusNumeroNoCiclo)}
      </h2>

      {/*
        Ação de alta frequência: o texto muda a cada segundo e não recebe
        nenhuma transição (§9.2 do DESIGN-TOKENS). `tabular-nums` evita o
        dígito "1" estreito fazendo o mostrador tremer a cada troca — não é
        cor nem duração, então não entra no contrato de tokens.

        `text-5xl` passa do que a escala tipográfica documenta (§4 vai até
        `text-3xl`); é de propósito: este é o único número "herói" do app —
        o cronômetro em si — e §4 descreve a escala do Tailwind em rem como a
        fonte, não uma lista fechada. Nenhum hex nem valor arbitrário entra
        aqui, só um degrau maior da mesma escala.

        Sem `aria-live`: anunciar a cada segundo seria ruído para quem usa
        leitor de tela. O rótulo da fase e os botões já dizem o que importa.
      */}
      <p className="mt-2 font-display text-5xl leading-none tabular-nums text-ink">
        {formatarTempo(segundosRestantes)}
      </p>

      <div className="mt-6 flex gap-2">
        {status === "executando" ? (
          <button
            type="button"
            onClick={pausar}
            className="rounded-sm bg-emerald px-4 py-2 text-sm font-medium text-on-emerald transition duration-150 ease-out hover:brightness-110 active:scale-97"
          >
            Pausar
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void iniciar()}
            className="rounded-sm bg-emerald px-4 py-2 text-sm font-medium text-on-emerald transition duration-150 ease-out hover:brightness-110 active:scale-97"
          >
            Iniciar
          </button>
        )}
        <button
          type="button"
          onClick={() => void reiniciar()}
          disabled={!temSessaoParaReiniciar}
          className="rounded-sm border border-border bg-surface px-4 py-2 text-sm text-ink transition duration-150 ease-out hover:bg-surface-raised active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
        >
          Reiniciar
        </button>
      </div>

      {erro ? (
        <p role="alert" className="mt-4 text-sm text-terracotta-ink">
          {erro}
        </p>
      ) : null}
    </section>
  );
}
