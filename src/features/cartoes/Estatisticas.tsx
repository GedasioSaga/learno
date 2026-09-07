import { useEffect, useState } from "react";
import { AppError, estudoEstatisticas, type EstatisticasDeEstudo } from "../../lib/ipc";
import {
  DIAS_DO_MAPA_DE_CALOR,
  construirMapaDeCalor,
  dataPorExtenso,
  descricaoDoDia,
  maximoDeRevisoes,
  nivelDeIntensidade,
  type CelulaDeCalor,
} from "./estatisticas-utils";
import { useCartoesStore } from "./store";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * Cor de cada nível de intensidade — sempre `mint` (o mesmo tom que
 * `ContadoresBadge` usa pra "pronto pra revisar hoje"), nunca um verde fixo:
 * em opacidade crescente, a cor segue o tema ativo em vez de destoar dele
 * nos temas mais claros ou no Alto contraste.
 */
const CLASSE_POR_NIVEL: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "bg-surface-sunken",
  1: "bg-mint/25",
  2: "bg-mint/50",
  3: "bg-mint/80",
  4: "bg-mint",
};

const NOMES_DOS_DIAS = ["D", "S", "T", "Q", "Q", "S", "S"];

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

/**
 * A aba Estatísticas: mapa de calor anual (estilo Anki), os quatro números
 * de hábito e a retenção — tudo derivado de `estudoEstatisticas`, o comando
 * que o contrato já define mas que `study_stats` ainda não atende no
 * backend (ver comentário na tarefa: erro nesta tela, por enquanto, É o
 * esperado — por isso o estado de erro é elegante, não uma tela branca).
 *
 * O mapa de calor em si é decorativo (`aria-hidden`, com `title` por extenso
 * pra quem usa mouse): a MESMA informação, dia a dia, mora sempre visível na
 * tabela de `<details>` logo abaixo, porque um mapa de calor sem teclado é
 * inútil pra quem não usa mouse.
 */
export function Estatisticas() {
  const deckSelecionadoId = useCartoesStore((state) => state.deckSelecionadoId);

  const [status, setStatus] = useState<"carregando" | "pronto" | "erro">("carregando");
  const [dados, setDados] = useState<EstatisticasDeEstudo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    setStatus("carregando");
    setErrorMessage(null);
    estudoEstatisticas(deckSelecionadoId, DIAS_DO_MAPA_DE_CALOR)
      .then((resultado) => {
        if (cancelado) return;
        setDados(resultado);
        setStatus("pronto");
      })
      .catch((error: unknown) => {
        if (cancelado) return;
        setErrorMessage(messageFor(error, "Não foi possível carregar as estatísticas."));
        setStatus("erro");
      });
    return () => {
      cancelado = true;
    };
  }, [deckSelecionadoId]);

  if (status === "carregando") {
    return <p className="p-6 text-sm text-ink-muted">Carregando estatísticas…</p>;
  }

  if (status === "erro" || !dados) {
    return (
      <p role="alert" className="p-6 text-sm text-terracotta-ink">
        {errorMessage}
      </p>
    );
  }

  if (dados.diasEstudados === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <h2 className="font-display text-xl text-ink">Ainda sem histórico por aqui</h2>
        <p className="max-w-sm text-sm text-ink-muted">
          Assim que você estudar um dia, o mapa de calor e os números de hábito aparecem aqui.
        </p>
      </div>
    );
  }

  const semanas = construirMapaDeCalor(dados.porDia, DIAS_DO_MAPA_DE_CALOR, new Date());
  const maximo = maximoDeRevisoes(semanas);
  const diasNaJanela: CelulaDeCalor[] = semanas.flat().filter((celula) => celula.naJanela);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <h2 className="font-display text-xl text-ink">Estatísticas</h2>

      <div>
        {/* `aria-hidden`: decorativo por natureza (cor não carrega texto). A dica
            de `title` serve só a quem usa mouse — a tabela abaixo é o mesmo dado,
            sempre em texto. */}
        <div aria-hidden="true" className="flex gap-[3px] overflow-x-auto pb-1">
          <div className="flex flex-col gap-[3px] pr-1 text-[10px] text-ink-muted">
            {NOMES_DOS_DIAS.map((nome, indice) => (
              <span key={indice} className="flex h-[11px] w-3 items-center justify-center leading-none">
                {indice % 2 === 1 ? nome : ""}
              </span>
            ))}
          </div>
          {semanas.map((semana, indiceSemana) => (
            <div key={indiceSemana} className="flex flex-col gap-[3px]">
              {semana.map((celula) =>
                celula.naJanela ? (
                  <div
                    key={celula.dia}
                    title={descricaoDoDia(celula)}
                    className={`size-[11px] rounded-[2px] ${CLASSE_POR_NIVEL[nivelDeIntensidade(celula.revisoes, maximo)]}`}
                  />
                ) : (
                  <div key={celula.dia} className="size-[11px]" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CartaoDeNumero rotulo="Média diária" valor={dados.mediaDiaria.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} />
        <CartaoDeNumero rotulo="Dias estudados" valor={String(dados.diasEstudados)} />
        <CartaoDeNumero rotulo="Maior sequência" valor={`${dados.maiorSequencia} dia${dados.maiorSequencia === 1 ? "" : "s"}`} />
        <CartaoDeNumero rotulo="Sequência atual" valor={`${dados.sequenciaAtual} dia${dados.sequenciaAtual === 1 ? "" : "s"}`} />
      </div>

      {dados.retencao !== null ? (
        <p className="text-sm text-ink-muted">
          <span className="font-medium text-ink">{Math.round(dados.retencao * 100)}% de retenção</span> — fração das
          revisões de cartões já maduros respondidas como "Bom" ou "Fácil".
        </p>
      ) : null}

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-muted transition-colors duration-150 ease-out motion-reduce:transition-none hover:text-ink">
          Ver revisões por dia
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto rounded-sm border border-hairline">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-raised text-ink-muted">
              <tr>
                <th scope="col" className="px-2 py-1 font-medium">
                  Dia
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  Revisões
                </th>
              </tr>
            </thead>
            <tbody>
              {[...diasNaJanela].reverse().map((celula) => (
                <tr key={celula.dia} className="border-t border-hairline">
                  <td className="px-2 py-1 text-ink">{dataPorExtenso(celula.data)}</td>
                  <td className="px-2 py-1 tabular-nums text-ink">{celula.revisoes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
