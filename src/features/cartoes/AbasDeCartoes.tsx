import type { TelaDeCartoes } from "./store";

/** As quatro abas navegáveis da seção — `"estudo"` e `"opcoes"` ficam de fora de propósito (ver `TelaDeCartoes`). */
type AbaDeCartoes = Exclude<TelaDeCartoes, "estudo" | "opcoes">;

const ABAS: readonly { tela: AbaDeCartoes; rotulo: string }[] = [
  { tela: "resumo", rotulo: "Baralhos" },
  { tela: "criar", rotulo: "Adicionar" },
  { tela: "painel", rotulo: "Painel" },
  { tela: "estatisticas", rotulo: "Estatísticas" },
];

interface AbasDeCartoesProps {
  telaAtiva: AbaDeCartoes;
  onIrPara: (tela: TelaDeCartoes) => void;
}

/**
 * A barra de abas do topo da seção Cartões — o "pequeno menu acima de Todos
 * os baralhos" do pedido, no mesmo espírito da barra do Anki (sem
 * Sincronizar: este app não tem servidor, e uma aba que não sincroniza nada
 * seria mentira).
 *
 * `aria-current="page"` em vez do padrão ARIA tablist/tab/tabpanel — mesmo
 * idioma de navegação de `Rail.tsx` e `SettingsScreen.tsx` (nav com botões +
 * estado ativo anunciado), pra seção inteira falar uma língua só em vez de
 * misturar duas.
 */
export function AbasDeCartoes({ telaAtiva, onIrPara }: AbasDeCartoesProps) {
  return (
    <nav aria-label="Abas de Cartões" className="flex shrink-0 gap-1 border-b border-hairline px-3">
      {ABAS.map((aba) => {
        const ativa = aba.tela === telaAtiva;
        return (
          <button
            key={aba.tela}
            type="button"
            aria-current={ativa ? "page" : undefined}
            onClick={() => onIrPara(aba.tela)}
            className={[
              "border-b-2 px-3 py-2.5 text-sm transition-colors duration-150 ease-out motion-reduce:transition-none",
              ativa ? "border-amber font-medium text-ink" : "border-transparent text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            {aba.rotulo}
          </button>
        );
      })}
    </nav>
  );
}
