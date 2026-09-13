import { useEffect, useState } from "react";
import { AppError, pomodoroToday } from "../../lib/ipc";
import { desafiosHoje, nivelAtual, registrarXpDesafioDiario, type Desafio, type EstadoDeNivel } from "./ipc";

function messageFor(erro: unknown, fallback: string): string {
  return erro instanceof AppError ? erro.message : fallback;
}

interface DadosDeProgresso {
  nivel: EstadoDeNivel;
  desafios: Desafio[];
  /**
   * Dias seguidos com pelo menos um foco de Pomodoro completo, contando hoje
   * — o mesmo `pomodoroToday().sequenciaDias` que a seção Hoje já expõe.
   * Não existe uma "sequência de gamificação" separada: reusar o valor que
   * já mede o hábito de estudo evita duas contagens de "dias seguidos" que
   * poderiam divergir.
   */
  sequenciaDias: number;
}

type Estado =
  | { tipo: "carregando" }
  | { tipo: "pronto"; dados: DadosDeProgresso }
  | { tipo: "erro"; mensagem: string };

/**
 * O cartão de progresso da tela Hoje: nível atual, barra para o próximo,
 * sequência de dias e os desafios do dia com o progresso de cada um.
 *
 * Três chamadas independentes (`nivelAtual`, `desafiosHoje`, `pomodoroToday`),
 * cada uma podendo falhar sem derrubar as outras duas — mesmo padrão de
 * `Promise.all` que `PlanoDoDia` já usa nesta seção.
 *
 * NENHUM número aqui é recalculado a partir de outro: `nivel.progresso` vem
 * pronto do backend (`db::gamificacao::calcular_nivel`) e é usado como está —
 * este componente não deriva a fração de `xpNoNivelAtual`/`xpParaProximoNivel`
 * por conta própria, porque duas contas do mesmo número podem divergir (é
 * exatamente a regra mais forte deste projeto).
 */
export function CartaoDeProgresso() {
  const [estado, setEstado] = useState<Estado>({ tipo: "carregando" });

  useEffect(() => {
    let cancelado = false;

    Promise.all([nivelAtual(), desafiosHoje(), pomodoroToday()])
      .then(([nivel, desafios, pomodoro]) => {
        if (cancelado) return;
        setEstado({ tipo: "pronto", dados: { nivel, desafios, sequenciaDias: pomodoro.sequenciaDias } });
      })
      .catch((erro: unknown) => {
        if (cancelado) return;
        setEstado({ tipo: "erro", mensagem: messageFor(erro, "Não foi possível carregar o seu progresso.") });
      });

    return () => {
      cancelado = true;
    };
  }, []);

  return (
    <section
      aria-labelledby="cartao-de-progresso-titulo"
      className="flex flex-col items-start rounded-md border border-border bg-surface p-6 shadow-hard-sm"
    >
      <h2 id="cartao-de-progresso-titulo" className="text-sm font-medium text-ink-muted">
        Seu progresso
      </h2>

      {estado.tipo === "carregando" ? <p className="mt-2 text-sm text-ink-muted">Carregando…</p> : null}

      {estado.tipo === "erro" ? (
        <p role="alert" className="mt-2 text-sm text-terracotta-ink">
          {estado.mensagem}
        </p>
      ) : null}

      {estado.tipo === "pronto" ? <ProgressoPronto dados={estado.dados} /> : null}
    </section>
  );
}

/**
 * Estado vazio honesto (item 3 do pedido): `xpTotal === 0` só acontece para
 * quem nunca gerou um evento de XP — nenhuma revisão, nenhum Pomodoro
 * concluído, nenhum bloco do cronograma cumprido. Em vez de mostrar "Nível 1
 * — 0%" e uma lista de desafios todos em 0, que pareceria uma tela quebrada,
 * este é o único lugar do componente que decide "nunca estudou".
 */
function EstadoVazio() {
  return (
    <>
      <p className="mt-2 font-display text-xl leading-tight text-ink">Comece a estudar para acumular XP</p>
      {/* O texto diz exatamente o que o sistema FAZ, nem mais nem menos, e já
          errou nas duas direções.
          Primeiro prometia demais: "cada revisão, cada Pomodoro e cada bloco
          do cronograma soma XP", com nenhuma tela chamando os comandos que
          creditariam isso — revisar cartão não dava XP nenhum.
          Hoje revisão e Pomodoro creditam sozinhos, dentro da mesma transação
          que grava a resposta e a sessão. Bloco do cronograma continua de
          fora, e não por esquecimento: não existe no app nenhuma ação de
          "marcar bloco como cumprido", então não há evento a que o crédito
          possa reagir. Quando essa ação existir, ele entra aqui. */}
      <p className="mt-1 text-sm text-ink-muted">
        Cada revisão de cartão e cada Pomodoro de foco concluído somam XP sozinhos. Os desafios do dia você registra
        aqui embaixo.
      </p>
    </>
  );
}

function ProgressoPronto({ dados }: { dados: DadosDeProgresso }) {
  const [desafios, setDesafios] = useState(dados.desafios);
  // O nivel tambem e estado, e nao um valor congelado do primeiro fetch.
  //
  // Creditar a XP de um desafio muda o total, e podia cruzar uma fronteira de
  // nivel: o item virava "creditado" e o "Nivel 1 - 500 XP" ao lado continuava
  // mostrando o numero de ANTES, ate alguem recarregar a tela. A XP ja estava
  // gravada em `xp_events`; era so a tela que mentia sobre ela.
  const [nivel, setNivel] = useState(dados.nivel);
  const { sequenciaDias } = dados;

  if (nivel.xpTotal === 0) {
    return <EstadoVazio />;
  }

  const progressoPercentual = Math.round(nivel.progresso * 100);

  return (
    <>
      <div className="mt-2 flex items-baseline gap-2">
        <p className="font-display text-3xl leading-tight text-ink">Nível {nivel.nivel}</p>
        <p className="text-sm text-ink-muted">{nivel.xpTotal} XP no total</p>
      </div>

      <div className="mt-3 flex w-full flex-col gap-1">
        <progress
          aria-label={`Progresso para o nível ${nivel.nivel + 1}`}
          value={progressoPercentual}
          max={100}
          className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken
            [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-surface-sunken
            [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-emerald"
        />
        <p className="text-xs text-ink-muted">
          Faltam {nivel.xpParaProximoNivel} XP para o nível {nivel.nivel + 1}
        </p>
      </div>

      <p className="mt-4 text-sm text-ink">
        {sequenciaDias > 0
          ? `${sequenciaDias} dia${sequenciaDias === 1 ? "" : "s"} seguido${sequenciaDias === 1 ? "" : "s"} de foco`
          : "Nenhum dia seguido de foco ainda"}
      </p>

      <h3 className="mt-5 text-xs font-medium uppercase tracking-wide text-ink-muted">Desafios de hoje</h3>
      <ul className="mt-2 flex w-full flex-col gap-2">
        {desafios.map((desafio) => (
          <DesafioItem
            key={desafio.tipo}
            desafio={desafio}
            onCreditado={(creditado) => {
              setDesafios((atual) => atual.map((item) => (item.tipo === desafio.tipo ? creditado : item)));
              // Rele o nivel do backend em vez de somar a recompensa aqui:
              // duas contas do mesmo total divergem, e a curva de nivel mora
              // no Rust. Falha em reler nao desfaz o credito (que ja esta no
              // banco), so deixa o numero velho ate o proximo carregamento.
              void nivelAtual().then(setNivel).catch(() => undefined);
            }
            }
          />
        ))}
      </ul>
    </>
  );
}

function DesafioItem({ desafio, onCreditado }: { desafio: Desafio; onCreditado: (creditado: Desafio) => void }) {
  const [registrando, setRegistrando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const progressoLimitado = Math.min(desafio.progresso, desafio.meta);
  const podeRegistrar = desafio.concluido && !desafio.xpCreditado;

  function handleRegistrar() {
    setRegistrando(true);
    setErro(null);
    registrarXpDesafioDiario(desafio.tipo)
      .then(() => {
        onCreditado({ ...desafio, xpCreditado: true });
      })
      .catch((erroChamada: unknown) => {
        setErro(messageFor(erroChamada, "Não foi possível registrar o XP deste desafio."));
      })
      .finally(() => {
        setRegistrando(false);
      });
  }

  return (
    <li className="flex flex-col gap-1.5 rounded-sm border border-border bg-surface-sunken px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-ink">{desafio.titulo}</span>
        <span className={desafio.concluido ? "font-medium text-mint-ink" : "text-ink-muted"}>
          {progressoLimitado} de {desafio.meta} {desafio.unidade}
        </span>
      </div>
      <progress
        aria-label={`Progresso de ${desafio.titulo}`}
        value={progressoLimitado}
        max={desafio.meta}
        className="h-1 w-full overflow-hidden rounded-full bg-surface-raised
          [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-surface-raised
          [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-mint"
      />
      {desafio.xpCreditado ? (
        <p className="text-xs text-mint-ink">{desafio.xpRecompensa} XP creditado</p>
      ) : podeRegistrar ? (
        <button
          type="button"
          onClick={handleRegistrar}
          disabled={registrando}
          className="self-start rounded-sm border border-border bg-surface px-2 py-1 text-xs text-ink transition
            duration-150 ease-out motion-reduce:transition-none hover:bg-surface-raised active:scale-97
            disabled:pointer-events-none disabled:opacity-60"
        >
          {registrando ? "Registrando…" : `Registrar ${desafio.xpRecompensa} XP`}
        </button>
      ) : null}
      {erro ? (
        <p role="alert" className="text-xs text-terracotta-ink">
          {erro}
        </p>
      ) : null}
    </li>
  );
}
