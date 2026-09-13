import { useEffect } from "react";
import { CabecalhoDeFinancas } from "./CabecalhoDeFinancas";
import { Lancamentos } from "./Lancamentos";
import { RendaEFixos } from "./RendaEFixos";
import { useFinancasStore } from "./store";
import { VisaoGeral } from "./VisaoGeral";

/**
 * A seção Finanças: o mês aberto no topo e três sub-abas ligadas por ele —
 * Visão geral, Lançamentos e Renda e fixos. Ocupa a largura inteira, sem
 * painel lateral, como Cronograma.
 *
 * Fica para as próximas entregas (combinado com o usuário): orçamento por
 * categoria, simulador de cenários para comparar salários, e o assistente
 * Gemini que propõe cenários.
 */
export function ConteudoDeFinancas() {
  const status = useFinancasStore((state) => state.status);
  const errorMessage = useFinancasStore((state) => state.errorMessage);
  const resumo = useFinancasStore((state) => state.resumo);
  const subAba = useFinancasStore((state) => state.subAba);
  const carregar = useFinancasStore((state) => state.carregar);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-8">
      <CabecalhoDeFinancas />

      {/* Sem resumo ainda não há nada confiável para mostrar: carga ou erro
          ocupam o lugar. Com resumo, trocar de mês mantém a tela anterior até
          o novo chegar, em vez de piscar "Carregando". */}
      {!resumo ? (
        status === "error" ? (
          <p role="alert" className="text-sm text-terracotta-ink">
            {errorMessage ?? "Não foi possível carregar as finanças."}
          </p>
        ) : (
          <p className="text-sm text-ink-muted">Carregando finanças…</p>
        )
      ) : (
        <>
          {subAba === "visao-geral" ? <VisaoGeral resumo={resumo} /> : null}
          {subAba === "lancamentos" ? <Lancamentos /> : null}
          {subAba === "renda-e-fixos" ? <RendaEFixos /> : null}

          {errorMessage ? (
            <p role="alert" className="text-sm text-terracotta-ink">
              {errorMessage}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
