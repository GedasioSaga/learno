import { useEffect, useState } from "react";
import { AppError, deckCounts, type DeckCounts } from "../../lib/ipc";
import { useNavegacaoStore } from "../navegacao";

type Estado =
  | { tipo: "carregando" }
  | { tipo: "pronto"; contagens: DeckCounts }
  | { tipo: "erro"; mensagem: string };

/**
 * "Cartões para hoje": o total que `deckCounts()` (sem `deckId` — a coleção
 * inteira) diz que vence agora, novos + em aprendizado + para revisar
 * somados. Sem número inventado: coleção vazia mostra 0 de verdade, não um
 * placeholder de exemplo.
 */
export function CartaoCartoesHoje() {
  const [estado, setEstado] = useState<Estado>({ tipo: "carregando" });
  const irParaCartoes = useNavegacaoStore((state) => state.irPara);

  useEffect(() => {
    let cancelado = false;
    deckCounts()
      .then((contagens) => {
        if (cancelado) return;
        setEstado({ tipo: "pronto", contagens });
      })
      .catch((erro: unknown) => {
        if (cancelado) return;
        setEstado({
          tipo: "erro",
          mensagem: erro instanceof AppError ? erro.message : "Não foi possível carregar os cartões de hoje.",
        });
      });
    return () => {
      cancelado = true;
    };
  }, []);

  return (
    <section
      aria-labelledby="cartao-cartoes-hoje-titulo"
      className="flex flex-col items-start rounded-md border border-border bg-surface p-6 shadow-hard-sm"
    >
      <h2 id="cartao-cartoes-hoje-titulo" className="text-sm font-medium text-ink-muted">
        Cartões para hoje
      </h2>

      {estado.tipo === "carregando" ? <p className="mt-2 text-sm text-ink-muted">Carregando…</p> : null}

      {estado.tipo === "erro" ? (
        <p role="alert" className="mt-2 text-sm text-terracotta-ink">
          {estado.mensagem}
        </p>
      ) : null}

      {estado.tipo === "pronto" ? (
        <CartoesProntos
          contagens={estado.contagens}
          onEstudar={() => irParaCartoes("cartoes")}
        />
      ) : null}
    </section>
  );
}

function CartoesProntos({ contagens, onEstudar }: { contagens: DeckCounts; onEstudar: () => void }) {
  const total = contagens.novos + contagens.aprendendo + contagens.revisar;

  return (
    <>
      <p className="mt-2 font-display text-3xl leading-tight text-ink">{total}</p>

      <dl className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        <div className="flex items-center gap-1.5">
          <dt>Novos</dt>
          <dd className="font-medium text-ink">{contagens.novos}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>Aprendendo</dt>
          <dd className="font-medium text-ink">{contagens.aprendendo}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <dt>Revisar</dt>
          <dd className="font-medium text-ink">{contagens.revisar}</dd>
        </div>
      </dl>

      {total > 0 ? (
        <button
          type="button"
          onClick={onEstudar}
          className="mt-4 rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink transition duration-150 ease-out hover:bg-surface-raised active:scale-97"
        >
          Estudar agora
        </button>
      ) : (
        <p className="mt-4 text-sm text-ink-muted">Nada para estudar agora.</p>
      )}
    </>
  );
}
