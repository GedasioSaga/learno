import { useEffect, useState } from "react";
import { AppError, estudoEstatisticas, type RevisaoDoDia } from "../../lib/ipc";
import { nivelAtual, recordesPessoais, type EstadoDeNivel, type RecordesPessoais } from "./ipc";

/**
 * Janela do gráfico de atividade recente — curta de propósito: é um retrato
 * de "você tem estudado?", não uma análise longa (essa já existe na aba
 * Estatísticas de Cartões, que lê a mesma `estudoEstatisticas`).
 */
const DIAS_DE_ATIVIDADE = 14;

function messageFor(erro: unknown, fallback: string): string {
  return erro instanceof AppError ? erro.message : fallback;
}

interface DadosDeConquistas {
  nivel: EstadoDeNivel;
  recordes: RecordesPessoais;
  atividade: RevisaoDoDia[];
}

type Estado =
  | { tipo: "carregando" }
  | { tipo: "pronto"; dados: DadosDeConquistas }
  | { tipo: "erro"; mensagem: string };

/**
 * A tela de conquistas: recordes pessoais e a evolução recente de XP.
 *
 * Componente puro — NÃO está montado em lugar nenhum ainda. O pedido original
 * era dentro da seção Cartões, mas `src/features/cartoes/**` está sendo
 * escrito por outro agente nesta mesma rodada; relatar onde montar (em vez de
 * tocar naquela pasta) é a decisão deste arquivo. Ver o relatório desta
 * tarefa para a sugestão de onde plugar isto.
 *
 * ## Sobre "evolução de XP" — o que o dado sustenta
 *
 * Não existe, na Fase 1, nenhum comando que devolva o histórico de
 * `xp_events` por dia (`desafios_hoje`/`nivelAtual`/`recordesPessoais` só
 * expõem o TOTAL atual e recordes derivados de `review_log`, nunca uma série
 * temporal de XP). Desenhar um gráfico de "XP por dia" aqui seria inventar um
 * dado que o backend não fornece — exatamente o que a regra mais forte deste
 * projeto proíbe. Em vez disso, a seção "Atividade recente" abaixo mostra
 * REVISÕES por dia (`estudoEstatisticas`, já exposta e real), rotulada pelo
 * que ela de fato é. Ver o relatório desta tarefa para a sugestão de um
 * comando futuro que exponha XP por dia, se este substituto não bastar.
 */
export function PainelDeConquistas() {
  const [estado, setEstado] = useState<Estado>({ tipo: "carregando" });

  useEffect(() => {
    let cancelado = false;

    Promise.all([nivelAtual(), recordesPessoais(), estudoEstatisticas(null, DIAS_DE_ATIVIDADE)])
      .then(([nivel, recordes, estatisticas]) => {
        if (cancelado) return;
        setEstado({ tipo: "pronto", dados: { nivel, recordes, atividade: estatisticas.porDia } });
      })
      .catch((erro: unknown) => {
        if (cancelado) return;
        setEstado({ tipo: "erro", mensagem: messageFor(erro, "Não foi possível carregar suas conquistas.") });
      });

    return () => {
      cancelado = true;
    };
  }, []);

  return (
    <div aria-labelledby="painel-de-conquistas-titulo" className="flex flex-col gap-6 p-6">
      <h2 id="painel-de-conquistas-titulo" className="font-display text-xl text-ink">
        Conquistas
      </h2>

      {estado.tipo === "carregando" ? <p className="text-sm text-ink-muted">Carregando…</p> : null}

      {estado.tipo === "erro" ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {estado.mensagem}
        </p>
      ) : null}

      {estado.tipo === "pronto" ? <ConquistasProntas dados={estado.dados} /> : null}
    </div>
  );
}

interface CartaoDeNumeroProps {
  rotulo: string;
  valor: string;
}

function CartaoDeNumero({ rotulo, valor }: CartaoDeNumeroProps) {
  return (
    <div className="rounded-sm border border-border bg-surface px-4 py-3">
      <p className="text-2xl font-medium tabular-nums text-ink">{valor}</p>
      <p className="text-xs text-ink-muted">{rotulo}</p>
    </div>
  );
}

function ConquistasProntas({ dados }: { dados: DadosDeConquistas }) {
  const { nivel, recordes, atividade } = dados;

  // Mesma definição de "nunca estudou" que `CartaoDeProgresso` usa
  // (`xpTotal === 0`) — uma origem só para essa decisão em toda a feature,
  // para não existirem dois critérios de "vazio" que pudessem divergir.
  if (nivel.xpTotal === 0) {
    return (
      <>
        <p className="font-display text-xl leading-tight text-ink">Ainda sem conquistas por aqui</p>
        <p className="max-w-sm text-sm text-ink-muted">
          Assim que você começar a estudar, seu nível, seus recordes pessoais e sua atividade recente aparecem aqui.
        </p>
      </>
    );
  }

  const totalNaJanela = atividade.reduce((soma, dia) => soma + dia.revisoes, 0);
  const maximoNaJanela = atividade.reduce((maior, dia) => Math.max(maior, dia.revisoes), 0);

  return (
    <>
      <section aria-label="Nível e XP" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <CartaoDeNumero rotulo="Nível" valor={String(nivel.nivel)} />
        <CartaoDeNumero rotulo="XP total" valor={String(nivel.xpTotal)} />
        <CartaoDeNumero rotulo="XP para o próximo nível" valor={String(nivel.xpParaProximoNivel)} />
      </section>

      <section aria-label="Recordes pessoais" className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-muted">Seus recordes</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <CartaoDeNumero
            rotulo="Melhor dia"
            valor={recordes.melhorDia ? `${recordes.melhorDia.revisoes} revisões` : "Nenhuma revisão registrada ainda"}
          />
          <CartaoDeNumero
            rotulo="Maior sequência"
            valor={`${recordes.maiorSequencia} dia${recordes.maiorSequencia === 1 ? "" : "s"}`}
          />
          <CartaoDeNumero
            rotulo="Melhor semana"
            valor={recordes.melhorSemana ? `${recordes.melhorSemana.revisoes} revisões` : "Nenhuma semana registrada ainda"}
          />
        </div>
      </section>

      <section aria-label="Atividade recente" className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          Revisões por dia (últimos {DIAS_DE_ATIVIDADE} dias)
        </h3>
        {totalNaJanela === 0 ? (
          <p className="text-sm text-ink-muted">Sem revisões nos últimos {DIAS_DE_ATIVIDADE} dias.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {atividade.map((dia) => (
              <li key={dia.dia} className="flex items-center gap-2 text-xs">
                <span className="w-20 shrink-0 text-ink-muted">{dia.dia}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                  <span
                    className="block h-full rounded-full bg-mint"
                    style={{ width: maximoNaJanela > 0 ? `${(dia.revisoes / maximoNaJanela) * 100}%` : "0%" }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums text-ink">{dia.revisoes}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
