import { useState } from "react";
import { formatarDataLocal, rotuloDoMes } from "./dinheiro";
import { BOTAO_PRIMARIO, BOTAO_SECUNDARIO, CARTAO } from "./estilos";
import type { LancamentoRow } from "./ipc";
import { LancamentoForm } from "./LancamentoForm";
import { useFinancasStore } from "./store";
import { Valor } from "./Valor";

/**
 * Os lançamentos do mês aberto, do dia 1º ao último. Fixos confirmados na
 * Visão geral aparecem aqui também, marcados como "fixo" — são lançamentos
 * de verdade, e apagar um deles devolve o fixo a pendente.
 */
export function Lancamentos() {
  const mes = useFinancasStore((state) => state.mes);
  const lancamentos = useFinancasStore((state) => state.lancamentos);
  const categorias = useFinancasStore((state) => state.categorias);
  const [editando, setEditando] = useState<LancamentoRow | "novo" | null>(null);

  const nomeDaCategoria = new Map(categorias.map((categoria) => [categoria.id, categoria.nome]));

  return (
    <section className="flex flex-col gap-4" aria-label={`Lançamentos de ${rotuloDoMes(mes)}`}>
      {editando === "novo" ? (
        <LancamentoForm onFechar={() => setEditando(null)} />
      ) : (
        <button type="button" onClick={() => setEditando("novo")} className={`${BOTAO_PRIMARIO} self-start`}>
          + Novo lançamento
        </button>
      )}

      {lancamentos.length === 0 ? (
        <p className={`${CARTAO} text-sm text-ink-muted`}>Nenhum lançamento em {rotuloDoMes(mes)}.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {lancamentos.map((lancamento) =>
            editando !== "novo" && editando?.id === lancamento.id ? (
              <li key={lancamento.id}>
                <LancamentoForm lancamento={lancamento} onFechar={() => setEditando(null)} />
              </li>
            ) : (
              <LinhaDeLancamento
                key={lancamento.id}
                lancamento={lancamento}
                categoria={lancamento.categoriaId ? (nomeDaCategoria.get(lancamento.categoriaId) ?? null) : null}
                onEditar={() => setEditando(lancamento)}
              />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

interface LinhaDeLancamentoProps {
  lancamento: LancamentoRow;
  categoria: string | null;
  onEditar: () => void;
}

function LinhaDeLancamento({ lancamento, categoria, onEditar }: LinhaDeLancamentoProps) {
  const removerLancamento = useFinancasStore((state) => state.removerLancamento);
  const [apagando, setApagando] = useState(false);

  async function handleApagar() {
    const aviso = lancamento.recorrenteId
      ? `Apagar "${lancamento.descricao}"? O fixo volta a ficar pendente neste mês.`
      : `Apagar "${lancamento.descricao}"? Isto não pode ser desfeito.`;
    if (!window.confirm(aviso)) return;
    setApagando(true);
    try {
      await removerLancamento(lancamento.id);
    } catch {
      setApagando(false);
    }
  }

  const centavos = lancamento.tipo === "saida" ? -lancamento.valorCentavos : lancamento.valorCentavos;

  return (
    <li className={`${CARTAO} flex flex-wrap items-center justify-between gap-3 py-3`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">
          {lancamento.descricao}
          {lancamento.recorrenteId ? (
            <span className="ml-2 rounded-sm border border-border px-1 text-xs font-normal text-ink-muted">fixo</span>
          ) : null}
        </p>
        <p className="text-xs text-ink-muted">
          {formatarDataLocal(lancamento.dataLocal)} · {lancamento.tipo === "entrada" ? "Entrada" : "Saída"} ·{" "}
          {categoria ?? "Sem categoria"}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Valor centavos={centavos} comSinal className="text-sm font-semibold text-ink" />
        <button type="button" onClick={onEditar} disabled={apagando} className={BOTAO_SECUNDARIO}>
          Editar
        </button>
        <button
          type="button"
          onClick={() => void handleApagar()}
          disabled={apagando}
          aria-label={`Apagar lançamento ${lancamento.descricao}`}
          className={`${BOTAO_SECUNDARIO} hover:text-terracotta-ink`}
        >
          {apagando ? "Apagando…" : "Apagar"}
        </button>
      </div>
    </li>
  );
}
