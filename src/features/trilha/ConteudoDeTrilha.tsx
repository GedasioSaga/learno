import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { EstadoVazioDeTrilha } from "./EstadoVazioDeTrilha";
import { useTrilhaStore } from "./store";
import { TrilhaCanvas } from "./TrilhaCanvas";

/**
 * A área principal da seção Trilha — implementa `ImplementacaoDaSecao.Conteudo`
 * (ver `features/navegacao/contrato.ts`). Sem props: o que está carregado mora
 * em `useTrilhaStore`, igual ao padrão de `ConteudoDeMapaMental`/`secao-notas.tsx`.
 *
 * Três telas, decididas por `status`:
 * - "erro": aviso visível com um jeito de tentar de novo — nunca tela branca.
 * - "pronta" com `trilha` carregada: o canvas.
 * - qualquer outra coisa ("vazia", ou "carregando" ainda sem `trilha` — que
 *   cobre tanto o carregamento inicial quanto o meio de `criarPrimeiraTrilha`,
 *   já que os dois têm `trilha === null` em comum): o convite de criar, que
 *   por si mostra "Criando…" no próprio botão enquanto a criação está em voo.
 */
export function ConteudoDeTrilha() {
  const status = useTrilhaStore((state) => state.status);
  const trilha = useTrilhaStore((state) => state.trilha);
  const errorMessage = useTrilhaStore((state) => state.errorMessage);
  const carregar = useTrilhaStore((state) => state.carregar);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (status === "erro") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p role="alert" className="max-w-sm text-sm text-terracotta-ink">
          {errorMessage ?? "Não foi possível carregar a trilha."}
        </p>
        <button
          type="button"
          onClick={() => void carregar()}
          className="rounded-sm border border-border bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
        >
          Tentar de novo
        </button>
      </div>
    );
  }

  if (status === "pronta" && trilha) {
    return (
      <ReactFlowProvider>
        <TrilhaCanvas />
      </ReactFlowProvider>
    );
  }

  return <EstadoVazioDeTrilha />;
}
