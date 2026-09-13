import { useState } from "react";
import { rotuloCurtoDoMes, rotuloDoMes } from "./dinheiro";
import { BOTAO_SECUNDARIO, CARTAO } from "./estilos";
import type { FixoDoMes, ResumoDoMes } from "./ipc";
import { useFinancasStore } from "./store";
import { Valor } from "./Valor";

/**
 * O mês de uma olhada: previsto contra realizado, os fixos que faltam pagar,
 * para onde foi o dinheiro e os próximos meses.
 *
 * Nenhuma conta é feita aqui — cada número vem de `resumoFinanceiroDoMes` e
 * `visaoFinanceiraPorMeses`. Uma sobra calculada em dois lugares poderia
 * divergir, e é a sobra que a pessoa usa para decidir.
 */
export function VisaoGeral({ resumo }: { resumo: ResumoDoMes }) {
  const visaoPorMeses = useFinancasStore((state) => state.visaoPorMeses);
  const definirMes = useFinancasStore((state) => state.definirMes);
  const definirSubAba = useFinancasStore((state) => state.definirSubAba);

  const semNada = resumo.fixos.length === 0 && resumo.entradasPrevistas === 0 && resumo.saidasPrevistas === 0;

  return (
    <div className="flex flex-col gap-6">
      {semNada ? (
        <div className={`${CARTAO} flex flex-wrap items-center justify-between gap-3`}>
          <p className="text-sm text-ink-muted">
            Nada previsto em {rotuloDoMes(resumo.mes)}. Comece cadastrando seu salário e seus gastos fixos.
          </p>
          <button type="button" onClick={() => definirSubAba("renda-e-fixos")} className={BOTAO_SECUNDARIO}>
            Cadastrar renda e fixos
          </button>
        </div>
      ) : null}

      <section aria-label="Resumo do mês" className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <CartaoDeTotal titulo="Entradas" previsto={resumo.entradasPrevistas} realizado={resumo.entradasRealizadas} />
        <CartaoDeTotal titulo="Saídas" previsto={resumo.saidasPrevistas} realizado={resumo.saidasRealizadas} />
        <CartaoDeTotal titulo="Sobra" previsto={resumo.sobraPrevista} realizado={resumo.sobraRealizada} destaque />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <FixosDoMes fixos={resumo.fixos} />

        <section className={CARTAO} aria-labelledby="titulo-por-categoria">
          <h2 id="titulo-por-categoria" className="mb-3 text-sm font-semibold text-ink">
            Gasto por categoria
          </h2>
          {resumo.porCategoria.length === 0 ? (
            <p className="text-sm text-ink-muted">Nenhuma saída lançada neste mês.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {resumo.porCategoria.map((gasto) => (
                <li key={gasto.categoriaId ?? "sem-categoria"} className="flex justify-between gap-3 text-sm">
                  <span className="text-ink">{gasto.nome ?? "Sem categoria"}</span>
                  <Valor centavos={gasto.saidasCentavos} className="text-ink" />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className={CARTAO} aria-labelledby="titulo-proximos-meses">
        <h2 id="titulo-proximos-meses" className="mb-3 text-sm font-semibold text-ink">
          Próximos meses
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-muted">
                <th scope="col" className="py-1 pr-3 font-normal">
                  Mês
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  Entradas previstas
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  Saídas previstas
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  Sobra prevista
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  Sobra realizada
                </th>
              </tr>
            </thead>
            <tbody>
              {visaoPorMeses.map((linha) => (
                <tr key={linha.mes} className="border-t border-border">
                  <td className="py-1 pr-3">
                    <button
                      type="button"
                      onClick={() => void definirMes(linha.mes)}
                      aria-current={linha.mes === resumo.mes ? "true" : undefined}
                      className={`text-left hover:underline ${
                        linha.mes === resumo.mes ? "font-semibold text-ink" : "text-ink-muted"
                      }`}
                    >
                      {rotuloCurtoDoMes(linha.mes)}
                    </button>
                  </td>
                  <td className="py-1 pr-3 text-right">
                    <Valor centavos={linha.entradasPrevistas} />
                  </td>
                  <td className="py-1 pr-3 text-right">
                    <Valor centavos={linha.saidasPrevistas} />
                  </td>
                  <td className="py-1 pr-3 text-right">
                    <Valor centavos={linha.sobraPrevista} comSinal />
                  </td>
                  <td className="py-1 text-right">
                    <Valor centavos={linha.sobraRealizada} comSinal />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

interface CartaoDeTotalProps {
  titulo: string;
  previsto: number;
  realizado: number;
  destaque?: boolean;
}

function CartaoDeTotal({ titulo, previsto, realizado, destaque = false }: CartaoDeTotalProps) {
  return (
    <div className={`${CARTAO} flex flex-col gap-2 ${destaque ? "bg-surface-raised" : ""}`}>
      <h2 className="text-xs font-medium uppercase tracking-wide text-ink-muted">{titulo}</h2>
      <dl className="grid grid-cols-2 gap-2">
        <div>
          <dt className="text-xs text-ink-muted">Previsto</dt>
          <dd className="text-lg font-semibold text-ink">
            <Valor centavos={previsto} comSinal={destaque} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Realizado</dt>
          <dd className="text-lg font-semibold text-ink">
            <Valor centavos={realizado} comSinal={destaque} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

function FixosDoMes({ fixos }: { fixos: FixoDoMes[] }) {
  const confirmarFixo = useFinancasStore((state) => state.confirmarFixo);
  const removerLancamento = useFinancasStore((state) => state.removerLancamento);
  const [processando, setProcessando] = useState<string | null>(null);

  async function executar(recorrenteId: string, acao: () => Promise<void>) {
    setProcessando(recorrenteId);
    try {
      await acao();
    } catch {
      // A mensagem já foi para `errorMessage` da store e aparece embaixo da tela.
    } finally {
      setProcessando(null);
    }
  }

  const pendentes = fixos.filter((fixo) => fixo.lancamentoId === null).length;

  return (
    <section className={CARTAO} aria-labelledby="titulo-fixos-do-mes">
      <h2 id="titulo-fixos-do-mes" className="mb-1 text-sm font-semibold text-ink">
        Fixos do mês
      </h2>
      <p className="mb-3 text-xs text-ink-muted">
        {fixos.length === 0
          ? "Nenhum fixo vale neste mês."
          : pendentes === 0
            ? "Todos confirmados."
            : `${pendentes} de ${fixos.length} ainda não confirmados.`}
      </p>
      <ul className="flex flex-col gap-2">
        {fixos.map((fixo) => {
          const confirmado = fixo.lancamentoId !== null;
          const ocupado = processando === fixo.recorrenteId;
          return (
            <li key={fixo.recorrenteId} className="flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate text-ink">{fixo.descricao}</p>
                <p className="text-xs text-ink-muted">
                  {fixo.tipo === "entrada" ? "Entrada" : "Saída"} ·{" "}
                  {confirmado ? (
                    <>
                      ✓ confirmado <Valor centavos={fixo.valorConfirmadoCentavos ?? 0} />
                    </>
                  ) : (
                    "○ pendente"
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Valor centavos={fixo.valorPrevistoCentavos} className="text-ink" />
                {confirmado ? (
                  <button
                    type="button"
                    disabled={ocupado}
                    onClick={() => {
                      const lancamentoId = fixo.lancamentoId;
                      if (lancamentoId) void executar(fixo.recorrenteId, () => removerLancamento(lancamentoId));
                    }}
                    aria-label={`Desfazer confirmação de ${fixo.descricao}`}
                    className={BOTAO_SECUNDARIO}
                  >
                    {ocupado ? "Desfazendo…" : "Desfazer"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={ocupado}
                    onClick={() => void executar(fixo.recorrenteId, () => confirmarFixo(fixo.recorrenteId))}
                    aria-label={`${fixo.tipo === "entrada" ? "Marcar como recebido" : "Marcar como pago"}: ${fixo.descricao}`}
                    className={BOTAO_SECUNDARIO}
                  >
                    {ocupado ? "Salvando…" : fixo.tipo === "entrada" ? "Recebido" : "Pago"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
