import { useEffect, useState } from "react";
import { AppError, pomodoroToday, semanaDeEstudo, type BlocoPlanejado } from "../../lib/ipc";
import { hojeLocal, inicioDaSemanaLocal } from "../cronograma/date-utils";
import { formatarDuracao, ROTULO_DA_ATIVIDADE } from "../cronograma/format";
import { useNavegacaoStore } from "../navegacao";

interface DadosDoDia {
  blocos: BlocoPlanejado[];
  totalPlanejadoMinutos: number;
  /**
   * Só os minutos planejados de atividade `pomodoro` — o único subconjunto
   * que `pomodoroToday()` de fato mede.
   *
   * A versão anterior comparava o foco do Pomodoro contra o total planejado
   * de QUALQUER atividade, e o número mentia nas duas direções: ler 60
   * minutos sem ligar o timer mostrava "0% cumprido", e rodar o Pomodoro em
   * algo fora do plano mostrava "50%" de um plano que ninguém tocou. A regra
   * deste projeto é que nada na tela afirma mais do que o dado sustenta.
   */
  minutosPlanejadosDePomodoro: number;
  minutosFocados: number;
}

type Estado =
  | { tipo: "carregando" }
  | { tipo: "pronto"; dados: DadosDoDia }
  | { tipo: "erro"; mensagem: string };

function messageFor(erro: unknown, fallback: string): string {
  return erro instanceof AppError ? erro.message : fallback;
}

/**
 * "Plano do dia": os blocos de HOJE vindos do Cronograma, e quanto do que foi
 * planejado já foi cumprido.
 *
 * Reusa `semanaDeEstudo` (já usada pela seção Cronograma) e filtra o dia de
 * hoje — não existe (nem deveria existir) um `diaDeEstudo(data)` separado só
 * para este cartão. `hojeLocal`/`inicioDaSemanaLocal` vêm de
 * `features/cronograma/date-utils`, não reimplementados aqui: duas contas de
 * "que dia é hoje" divergindo em silêncio é exatamente o bug que o comentário
 * daquele arquivo existe para evitar.
 *
 * "Cumprido hoje" vem de `pomodoroToday()` — não de `dia.minutosRealizados`
 * (que a `SemanaDeEstudo` já traz por dia). Os dois nomeiam o mesmo tipo de
 * dado (foco de Pomodoro), mas este cartão fixa `pomodoroToday()` por ser o
 * comando que a seção Hoje já expõe como "o resumo do dia" — trocar por
 * `minutosRealizados` é uma migração de fonte, não uma correção, e fica fora
 * desta rodada.
 *
 * Regra de exibição, e ela é sobre honestidade antes de ser sobre layout: a
 * porcentagem só aparece quando há minutos de POMODORO planejados, porque é a
 * única comparação em que numerador e denominador medem a mesma coisa. Um dia
 * planejado só em leitura e revisão mostra o foco como fato isolado e o total
 * planejado ao lado, sem afirmar cumprimento. Sem blocos E sem foco
 * registrado, o dia está genuinamente vazio: isto é normal, não um erro (ver
 * `CATALOGO_DE_SECOES` — Trilha e Cronograma continuam alcançáveis pelo rail
 * para quem quiser planejar).
 */
export function PlanoDoDia() {
  const [estado, setEstado] = useState<Estado>({ tipo: "carregando" });
  const irParaCronograma = useNavegacaoStore((state) => state.irPara);

  useEffect(() => {
    let cancelado = false;
    const hoje = hojeLocal();

    Promise.all([semanaDeEstudo(inicioDaSemanaLocal()), pomodoroToday()])
      .then(([semana, pomodoro]) => {
        if (cancelado) return;
        const dia = semana.dias.find((candidato) => candidato.data === hoje);
        const blocos = dia?.blocos ?? [];
        const totalPlanejadoMinutos = blocos.reduce((soma, bloco) => soma + bloco.plannedMinutes, 0);
        const minutosPlanejadosDePomodoro = blocos
          .filter((bloco) => bloco.activity === "pomodoro")
          .reduce((soma, bloco) => soma + bloco.plannedMinutes, 0);
        const minutosFocados = Math.round(pomodoro.segundosFocados / 60);
        setEstado({
          tipo: "pronto",
          dados: { blocos, totalPlanejadoMinutos, minutosPlanejadosDePomodoro, minutosFocados },
        });
      })
      .catch((erro: unknown) => {
        if (cancelado) return;
        setEstado({ tipo: "erro", mensagem: messageFor(erro, "Não foi possível carregar o plano do dia.") });
      });

    return () => {
      cancelado = true;
    };
  }, []);

  return (
    <section
      aria-labelledby="plano-do-dia-titulo"
      className="flex flex-col items-start rounded-md border border-border bg-surface p-6 shadow-hard-sm"
    >
      <h2 id="plano-do-dia-titulo" className="text-sm font-medium text-ink-muted">
        Plano do dia
      </h2>

      {estado.tipo === "carregando" ? <p className="mt-2 text-sm text-ink-muted">Carregando…</p> : null}

      {estado.tipo === "erro" ? (
        <p role="alert" className="mt-2 text-sm text-terracotta-ink">
          {estado.mensagem}
        </p>
      ) : null}

      {estado.tipo === "pronto" ? (
        <DiaPronto dados={estado.dados} onPlanejar={() => irParaCronograma("cronograma")} />
      ) : null}
    </section>
  );
}

function DiaPronto({ dados, onPlanejar }: { dados: DadosDoDia; onPlanejar: () => void }) {
  const { blocos, totalPlanejadoMinutos, minutosPlanejadosDePomodoro, minutosFocados } = dados;

  // A porcentagem só aparece quando há Pomodoro planejado, porque é a única
  // comparação em que numerador e denominador medem a mesma coisa. Com o dia
  // planejado só em leitura ou revisão, o foco continua sendo mostrado — como
  // fato isolado, sem afirmar cumprimento de um plano que ele não mede.
  const temComparacaoValida = minutosPlanejadosDePomodoro > 0;
  const textoCumprido = temComparacaoValida
    ? `${minutosFocados} min de ${minutosPlanejadosDePomodoro} min de Pomodoro planejados (${Math.round((minutosFocados / minutosPlanejadosDePomodoro) * 100)}%)`
    : `${minutosFocados} min de foco hoje`;

  // O resto do plano existe e conta, mas não é medido pelo timer — dizer o
  // total sem prometer progresso sobre ele é o que o dado sustenta.
  const restoDoPlano =
    totalPlanejadoMinutos > minutosPlanejadosDePomodoro
      ? `${totalPlanejadoMinutos} min planejados no total hoje`
      : null;

  if (blocos.length === 0) {
    // Dia sem bloco planejado. Só mostra "cumprido" se de fato houve foco sem
    // plano — um dia sem plano e sem foco nenhum é o estado vazio honesto,
    // não uma métrica de "0 min de foco hoje" que não diz nada a mais.
    return (
      <>
        <p className="mt-2 text-sm text-ink-muted">
          {minutosFocados > 0 ? textoCumprido : "Nada planejado para hoje."}
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          Um dia sem nada planejado é normal — quando quiser, monte a semana no Cronograma.
        </p>
        <button
          type="button"
          onClick={onPlanejar}
          className="mt-4 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink transition duration-150 ease-out motion-reduce:transition-none hover:bg-surface-raised active:scale-97"
        >
          Planejar no Cronograma
        </button>
      </>
    );
  }

  return (
    <>
      <p className="mt-2 font-display text-2xl leading-tight text-ink">{textoCumprido}</p>
      {restoDoPlano ? <p className="mt-1 text-sm text-ink-muted">{restoDoPlano}</p> : null}

      <ul className="mt-4 flex w-full flex-col gap-2">
        {blocos.map((bloco) => (
          <li
            key={bloco.id}
            className="flex items-center justify-between gap-2 rounded-sm border border-border bg-surface-sunken px-3 py-2 text-sm"
          >
            <span className="text-ink">
              {bloco.startLocalTime ? `${bloco.startLocalTime} · ` : ""}
              {bloco.title?.trim() ? bloco.title.trim() : ROTULO_DA_ATIVIDADE[bloco.activity]}
            </span>
            <span className="text-ink-muted">{formatarDuracao(bloco)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
