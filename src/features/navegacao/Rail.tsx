import type { ReactNode } from "react";
import { atalhoDaSecao } from "./catalogo";
import type { Secao, SecaoId } from "./contrato";

interface RailProps {
  secoes: readonly Secao[];
  secaoAtiva: SecaoId;
  onIrPara: (id: SecaoId) => void;
  /** O rodapé: recolher painel, Configurações, alternar tema. */
  rodape?: ReactNode;
}

/**
 * O rail de seções — a coluna estreita mais à esquerda, com as sete abas do
 * app. É o "Fluxograma, Cronograma e Trilha teriam suas próprias abas onde eu
 * pudesse clicar" do pedido, e também a porta de Notas, Cartões e Mapa mental.
 *
 * Ícone COM rótulo, e não ícone só com tooltip: sete ícones de traço sem nome
 * exigem decorar, e este app é para quem estuda, não para quem o usa oito
 * horas por dia. O custo é largura (82px, `w-22`), pago uma vez.
 *
 * Estado ativo conforme §8 do DESIGN-TOKENS: fundo `surface-raised` fixo,
 * texto `ink`, e o acento âmbar entra como INDICADOR (a barra de 2px à
 * esquerda e o ícone), nunca como fundo. `aria-current="page"` porque cada
 * seção é uma "página" do app no sentido de navegação.
 *
 * É um `nav` com botões, não com links: não há URL — o estado da seção mora
 * na store — e um `<a>` sem `href` seria um botão fingindo.
 */
export function Rail({ secoes, secaoAtiva, onIrPara, rodape }: RailProps) {
  return (
    <nav
      aria-label="Seções"
      className="flex w-22 shrink-0 flex-col border-r border-hairline bg-surface-sunken"
    >
      {/* A marca: mesma altura do cabeçalho do painel ao lado, para as duas
          colunas alinharem na linha de cima. O emoji pixelado é a única
          pixel art fora do estado vazio — de propósito, é a "alma" do ícone. */}
      <div className="flex h-14 shrink-0 items-center justify-center">
        <span aria-hidden="true" className="text-xl" style={{ imageRendering: "pixelated" }}>
          📚
        </span>
        <span className="sr-only">Learno</span>
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pt-1">
        {secoes.map((secao) => {
          const ativa = secao.id === secaoAtiva;
          const atalho = atalhoDaSecao(secao.id);
          const dica = atalho === null ? secao.resumo : `${secao.resumo} (Ctrl+${atalho})`;
          return (
            <li key={secao.id}>
              <button
                type="button"
                aria-current={ativa ? "page" : undefined}
                title={dica}
                onClick={() => onIrPara(secao.id)}
                className={[
                  "relative flex w-full flex-col items-center gap-1 rounded-sm px-1 py-2 text-xs transition duration-150 ease-out active:scale-97",
                  ativa ? "bg-surface-raised text-ink" : "text-ink-muted hover:bg-surface-raised hover:text-ink",
                ].join(" ")}
              >
                {ativa ? (
                  <span aria-hidden="true" className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-amber" />
                ) : null}
                <span className={["grid size-7 place-items-center", ativa ? "text-amber" : ""].join(" ")}>
                  {secao.icone}
                </span>
                <span className="max-w-full truncate leading-tight">{secao.nome}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-hairline p-2">{rodape}</div>
    </nav>
  );
}
