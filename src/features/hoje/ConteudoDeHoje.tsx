import { CartaoDeProgresso } from "../gamificacao";
import { CartaoPomodoro } from "../pomodoro";
import { CartaoDeProximoPrazo } from "../prazos";
import { CartaoCartoesHoje } from "./CartaoCartoesHoje";
import { PlanoDoDia } from "./PlanoDoDia";

/**
 * O conteúdo da seção Hoje: o plano do dia.
 *
 * Quatro cartões independentes, cada um com sua própria chamada e seu próprio
 * estado de carregando/erro (mesmo padrão de `CartaoCartoesHoje`) — nenhum
 * numero mostrado aqui é inventado, cada um vem de um comando de IPC real:
 * `CartaoDeProgresso` (nível, sequência e desafios do dia, de
 * `features/gamificacao`), `CartaoPomodoro` (o cronômetro em si), `PlanoDoDia`
 * (`semanaDeEstudo` + `pomodoroToday`, os blocos de hoje e quanto já foi
 * cumprido) e `CartaoCartoesHoje` (`deckCounts`, com o link de um clique para
 * a sessão de estudo de verdade, que mora na seção Cartões — não duplicada
 * aqui).
 *
 * O retângulo de "Trilha em construção" que existia aqui saiu: a Trilha já
 * tem seção própria no rail (ver `CATALOGO_DE_SECOES.trilha`), e repetir o
 * placeholder na tela principal era ruído, não informação — quem quiser ver
 * o que está planejado para a Trilha chega lá pelo rail.
 *
 * Fora desta rodada, de propósito (herdado da rodada anterior, ainda vale):
 * - "Horas na semana": o contrato de IPC só tem `pomodoroToday()` (o dia,
 *   não a semana). Rotular o total de hoje como "semana" seria exatamente o
 *   número inventado que o resto do app evita.
 * - O cartão de revisão espaçada com "a pergunta do dia": responder um
 *   cartão de verdade (mostrar frente/verso, os botões de novamente/difícil/
 *   bom/fácil) é o fluxo de estudo da seção Cartões, não um resumo do dia.
 *
 * `CartaoDeProgresso` abre a tela, antes até do Pomodoro: é o primeiro
 * cartão visto ao abrir o app, onde a motivação tem efeito.
 */
export function ConteudoDeHoje() {
  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <CartaoDeProgresso />

      {/* O proximo prazo vem logo depois do progresso e antes do resto: uma
          prova que se aproxima muda o que vale a pena estudar hoje, entao ela
          precisa ser lida ANTES do plano do dia, nao depois dele. */}
      <div className="mt-4">
        <CartaoDeProximoPrazo />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <CartaoPomodoro />
        <CartaoCartoesHoje />
      </div>

      <div className="mt-4">
        <PlanoDoDia />
      </div>
    </div>
  );
}
