import { useEffect, useState } from "react";
import { AppError } from "../../lib/ipc";
import { escolherMaisUrgente, formatarDataDoPrazo, nivelDeUrgencia, rotuloDeContagem, SIMBOLO_DE_URGENCIA, type NivelDeUrgencia } from "./format";
import { listarPrazos, type PrazoComContagem } from "./ipc";

const COR_DO_NIVEL: Record<NivelDeUrgencia, string> = {
  vencido: "text-terracotta-ink",
  hoje: "text-amber-ink",
  proximo: "text-ink",
  distante: "text-ink-muted",
};

type Estado =
  | { tipo: "carregando" }
  | { tipo: "pronto"; prazo: PrazoComContagem | null }
  | { tipo: "erro"; mensagem: string };

interface CartaoDeProximoPrazoProps {
  /**
   * Chamado quando a pessoa quer ver a lista inteira de prazos. Opcional:
   * este cartão não sabe navegar sozinho (Prazos não é uma seção do rail —
   * ver o comentário de `ListaDePrazos.tsx`), então quem monta este cartão
   * na tela Hoje decide para onde isso leva. Sem esta prop, o cartão
   * simplesmente não mostra o atalho.
   */
  onVerTodos?: () => void;
}

/**
 * O cartão compacto de "próximo prazo" para a tela Hoje — auto-suficiente
 * (busca seus próprios dados), mesmo padrão de `CartaoDeProgresso` e
 * `CartaoCartoesHoje` em `features/gamificacao`/`features/hoje`.
 *
 * Escolhe UM prazo para mostrar via `escolherMaisUrgente`: um vencido ainda
 * ativo tem prioridade sobre qualquer futuro — "próximo" aqui é "o que pede
 * atenção primeiro", nunca esconde um vencido para caber só o que ainda vai
 * acontecer.
 */
export function CartaoDeProximoPrazo({ onVerTodos }: CartaoDeProximoPrazoProps) {
  const [estado, setEstado] = useState<Estado>({ tipo: "carregando" });

  useEffect(() => {
    let cancelado = false;

    listarPrazos()
      .then((listagem) => {
        if (cancelado) return;
        setEstado({ tipo: "pronto", prazo: escolherMaisUrgente(listagem) });
      })
      .catch((erro: unknown) => {
        if (cancelado) return;
        setEstado({
          tipo: "erro",
          mensagem: erro instanceof AppError ? erro.message : "Não foi possível carregar os prazos.",
        });
      });

    return () => {
      cancelado = true;
    };
  }, []);

  return (
    <section
      aria-labelledby="cartao-proximo-prazo-titulo"
      className="flex flex-col items-start rounded-md border border-border bg-surface p-6 shadow-hard-sm"
    >
      <h2 id="cartao-proximo-prazo-titulo" className="text-sm font-medium text-ink-muted">
        Próximo prazo
      </h2>

      {estado.tipo === "carregando" ? <p className="mt-2 text-sm text-ink-muted">Carregando…</p> : null}

      {estado.tipo === "erro" ? (
        <p role="alert" className="mt-2 text-sm text-terracotta-ink">
          {estado.mensagem}
        </p>
      ) : null}

      {estado.tipo === "pronto" ? <PrazoOuVazio prazo={estado.prazo} onVerTodos={onVerTodos} /> : null}
    </section>
  );
}

/** Estado vazio honesto (item 5 do pedido): ninguém tem prazo nenhum cadastrado. */
function PrazoOuVazio({ prazo, onVerTodos }: { prazo: PrazoComContagem | null; onVerTodos?: () => void }) {
  if (prazo === null) {
    return <p className="mt-2 text-sm text-ink-muted">Nenhum prazo cadastrado ainda.</p>;
  }

  const nivel = nivelDeUrgencia(prazo.diasRestantes);

  return (
    <>
      <p className="mt-2 truncate font-display text-xl leading-tight text-ink">{prazo.title}</p>
      <p className={`mt-1 flex items-center gap-1.5 text-sm font-medium ${COR_DO_NIVEL[nivel]}`}>
        <span aria-hidden="true">{SIMBOLO_DE_URGENCIA[nivel]}</span>
        {rotuloDeContagem(prazo.diasRestantes)}
      </p>
      <p className="mt-1 text-xs text-ink-muted">{formatarDataDoPrazo(prazo.dueLocalDate)}</p>

      {onVerTodos ? (
        <button
          type="button"
          onClick={onVerTodos}
          className="mt-4 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink transition duration-150 ease-out motion-reduce:transition-none hover:bg-surface-raised active:scale-97"
        >
          Ver todos os prazos
        </button>
      ) : null}
    </>
  );
}
