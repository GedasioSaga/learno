import { useEffect } from "react";
import { AbasDeCartoes } from "./AbasDeCartoes";
import { CriarCartao } from "./CriarCartao";
import { Estatisticas } from "./Estatisticas";
import { EstudoSessao } from "./EstudoSessao";
import { OpcoesDoBaralho } from "./OpcoesDoBaralho";
import { PainelDePrevisao } from "./PainelDePrevisao";
import { ResumoDoBaralho } from "./ResumoDoBaralho";
import { useCartoesStore } from "./store";

/**
 * O conteúdo principal da seção Cartões: a barra de abas (Baralhos,
 * Adicionar, Painel, Estatísticas) e, embaixo, a tela correspondente a
 * `tela` na store. Chama `load()` de novo (além do `PainelDeCartoes`, que
 * também chama): a guarda em `store.load` contra chamadas concorrentes
 * existe exatamente para isto — cobre o caso do painel estar recolhido
 * (persistido de uma seção diferente) sem duplicar a rodada de rede no caso
 * comum em que os dois montam juntos.
 *
 * A sessão de estudo NÃO é aba: ela toma a tela inteira (sem a barra) assim
 * que começa. Ela só é alcançada a partir do botão Estudar em "resumo" (a
 * aba Baralhos), então "Voltar" — dentro de `EstudoSessao` — já volta pra
 * aba certa sem este componente precisar lembrar de nenhuma outra.
 *
 * As opções de um baralho também não são aba, mas ficam DENTRO da barra: são
 * uma subtela do resumo, então a aba "Baralhos" continua acesa enquanto o
 * usuário edita — é de lá que ele veio e é para lá que Voltar o leva.
 */
export function ConteudoDeCartoes() {
  const status = useCartoesStore((state) => state.status);
  const errorMessage = useCartoesStore((state) => state.errorMessage);
  const tela = useCartoesStore((state) => state.tela);
  const load = useCartoesStore((state) => state.load);
  const irPara = useCartoesStore((state) => state.irPara);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading" || status === "idle") {
    return <p className="p-6 text-sm text-ink-muted">Carregando baralhos…</p>;
  }

  if (status === "error") {
    return (
      <p role="alert" className="p-6 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar os baralhos."}
      </p>
    );
  }

  if (tela === "estudo") return <EstudoSessao />;

  return (
    <div className="flex h-full flex-col">
      <AbasDeCartoes telaAtiva={tela === "opcoes" ? "resumo" : tela} onIrPara={irPara} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tela === "opcoes" ? <OpcoesDoBaralho /> : null}
        {tela === "criar" ? <CriarCartao /> : null}
        {tela === "painel" ? <PainelDePrevisao /> : null}
        {tela === "estatisticas" ? <Estatisticas /> : null}
        {tela === "resumo" ? <ResumoDoBaralho /> : null}
      </div>
    </div>
  );
}
