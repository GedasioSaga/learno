import { useEffect, type ReactNode } from "react";
import type { Secao } from "../features/navegacao/contrato";
import { IconeMostrarPainel, IconeRecolherPainel } from "../features/navegacao/icones";
import { Rail } from "../features/navegacao/Rail";
import { useNavegacaoStore } from "../features/navegacao/store";
import "../features/navegacao/navegacao.css";
import { BotaoDeIcone } from "./BotaoDeIcone";
import { ThemeToggle } from "./ThemeToggle";

interface AppShellProps {
  /** As seções montadas por `montarSecoes` — a casca não sabe quais existem. */
  secoes: readonly Secao[];
  /**
   * Ações do rodapé do rail, entre o botão do painel e o alternador de tema.
   * Hoje é a entrada das Configurações. Fica no rail, e não flutuando sobre
   * o conteúdo, porque configuração é navegação — mora com o resto dela.
   */
  acoes?: ReactNode;
}

/**
 * A casca da interface: três colunas, da esquerda para a direita.
 *
 *   rail (82px) │ painel da seção (256px, opcional) │ conteúdo
 *
 * Por que rail + painel, e não uma lista única com cabeçalhos (o "Private" do
 * Notion com tudo dentro): cada seção precisa de um painel DIFERENTE — Notas
 * quer uma árvore com subníveis e arrasto, Cartões uma lista de baralhos com
 * três contadores por linha, Mapa mental uma lista simples — e três delas
 * (Hoje, Trilha, Cronograma) não querem painel nenhum. Numa lista única a
 * árvore de páginas disputaria altura com os baralhos, e a seção ativa se
 * perderia na rolagem. Com o rail, cada seção tem endereço fixo ("aba onde
 * eu pudesse clicar", nas palavras do usuário) e decide sozinha o que mostra
 * ao lado.
 *
 * A hierarquia é a da régua de elevação (§7 do DESIGN-TOKENS): rail e painel
 * são nível 0.5, rebaixados, porque são apoio; o conteúdo é nível 0, o papel
 * em si. Nenhuma sombra separa as colunas — sombra é para o eixo Z, e aqui a
 * separação é lateral, trabalho de um fio (`hairline`).
 *
 * Atalhos: Ctrl+1 … Ctrl+8 trocam de seção pela ordem do rail. Troca por
 * teclado não anima o conteúdo (§9.3); troca por clique anima em 180ms.
 */
export function AppShell({ secoes, acoes }: AppShellProps) {
  const secaoAtivaId = useNavegacaoStore((estado) => estado.secaoAtiva);
  const painelRecolhido = useNavegacaoStore((estado) => estado.painelRecolhido);
  const ultimaTrocaPor = useNavegacaoStore((estado) => estado.ultimaTrocaPor);
  const irPara = useNavegacaoStore((estado) => estado.irPara);
  const alternarPainel = useNavegacaoStore((estado) => estado.alternarPainel);

  // Uma seção persistida que a montagem atual não inclui (teste com subconjunto,
  // ou uma seção removida do app) cai na primeira, em vez de deixar a tela vazia.
  const secao = secoes.find((item) => item.id === secaoAtivaId) ?? secoes[0];

  useEffect(() => {
    function aoTeclar(evento: KeyboardEvent) {
      if (!(evento.ctrlKey || evento.metaKey) || evento.altKey || evento.shiftKey) return;
      const digito = Number.parseInt(evento.key, 10);
      if (!Number.isInteger(digito) || digito < 1 || digito > secoes.length) return;
      evento.preventDefault();
      irPara(secoes[digito - 1].id, "teclado");
    }
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [secoes, irPara]);

  if (!secao) {
    // `secoes` vazio é erro de montagem, não estado de produto — mas uma
    // casca em branco é pior que uma linha dizendo o motivo.
    return <p className="p-6 text-sm text-terracotta-ink">Nenhuma seção montada.</p>;
  }

  const { Painel, Conteudo } = secao;
  const temPainel = Painel !== null;
  const mostrarPainel = temPainel && !painelRecolhido;

  return (
    <div className="flex h-screen bg-paper text-ink">
      <Rail
        secoes={secoes}
        secaoAtiva={secao.id}
        onIrPara={(id) => irPara(id, "ponteiro")}
        rodape={
          <>
            {temPainel ? (
              <BotaoDeIcone rotulo={painelRecolhido ? "Mostrar painel" : "Recolher painel"} onClick={alternarPainel}>
                {painelRecolhido ? <IconeMostrarPainel /> : <IconeRecolherPainel />}
              </BotaoDeIcone>
            ) : null}
            {acoes}
            <ThemeToggle variante="icone" />
          </>
        }
      />

      {mostrarPainel ? (
        <aside
          aria-label={secao.nome}
          data-slot="painel-da-secao"
          className="flex w-64 shrink-0 flex-col border-r border-hairline bg-surface-sunken"
        >
          <div className="flex h-14 shrink-0 items-center px-4">
            <h2 className="font-display text-lg tracking-tight text-ink">{secao.nome}</h2>
          </div>
          <Painel />
        </aside>
      ) : null}

      {/* `key` remonta o conteúdo a cada troca: é o que zera a rolagem e o que
          faz a animação de entrada rodar de novo. */}
      <main
        key={secao.id}
        data-slot="content"
        className={["min-w-0 flex-1 overflow-y-auto", ultimaTrocaPor === "ponteiro" ? "entrada-de-secao" : ""].join(" ")}
      >
        <Conteudo />
      </main>
    </div>
  );
}
