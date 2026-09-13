import { useEffect } from "react";
import { CabecalhoDeSemana } from "./CabecalhoDeSemana";
import { ListaDePrazos } from "../prazos";
import { ColunaDoDia } from "./ColunaDoDia";
import { GradeSemanal } from "./GradeSemanal";
import { PainelDeMaterias } from "./PainelDeMaterias";
import { SeletorDeVisao } from "./SeletorDeVisao";
import { useCronogramaStore } from "./store";

/**
 * O conteúdo da seção Cronograma: a semana planejada contra a realizada, com
 * o dia de hoje destacado e a meta de horas no topo. Duas visões da MESMA
 * semana, alternadas por `SeletorDeVisao` (a escolha é lembrada — ver
 * `store.ts`): "Colunas", a original (uma lista por dia, segunda a
 * domingo), e "Grade" (`GradeSemanal.tsx`, faixa de horário × dia, cor por
 * matéria) — as duas convivem, nenhuma substitui a outra. Ocupa a largura
 * inteira — Cronograma não tem painel lateral (nada para listar; ver
 * `features/navegacao/contrato.ts`).
 *
 * Fora desta rodada, de propósito (folga insuficiente para fazer bem, e uma
 * tela que lê e cria bloco já vale mais que uma que arrasta mal):
 * - Arrastar um bloco entre dias, ou entre horários dentro da Grade.
 *   `moverBloco` já existe no contrato de IPC e no wrapper em `lib/ipc.ts`;
 *   a store e a UI daqui não o chamam ainda.
 * - Editar um bloco existente (`atualizarBloco`) e escolher baralho/página
 *   ao criar — `criarBloco` só recebe título como identificação livre. Por
 *   isso a Grade é só leitura/posicionamento: criar e remover bloco
 *   continuam exclusivos da visão de Colunas (`NovoBlocoForm`, `BlocoCard`).
 */
export function ConteudoDeCronograma() {
  const status = useCronogramaStore((state) => state.status);
  const errorMessage = useCronogramaStore((state) => state.errorMessage);
  const semana = useCronogramaStore((state) => state.semana);
  const visao = useCronogramaStore((state) => state.visao);
  const load = useCronogramaStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading" || status === "idle") {
    return <p className="p-6 text-sm text-ink-muted">Carregando semana…</p>;
  }

  if (status === "error" || !semana) {
    return (
      <p role="alert" className="p-6 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar a semana."}
      </p>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-8">
      <CabecalhoDeSemana semana={semana} />

      <SeletorDeVisao />

      {visao === "grade" ? (
        <GradeSemanal semana={semana} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
          {semana.dias.map((dia) => (
            <ColunaDoDia key={dia.data} dia={dia} />
          ))}
        </div>
      )}

      {/* Erro de uma ação (criar/remover bloco, salvar meta) — a semana já
          carregada continua na tela; só um aviso embaixo, mesmo padrão de
          `PainelDeCartoes`. Diferente do erro de `load()` acima, que troca a
          tela inteira porque aí não há nada confiável para mostrar. */}
      {errorMessage ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {errorMessage}
        </p>
      ) : null}

      {/* Prazos moram aqui, e nao numa secao propria do rail, porque um prazo
          e uma data que puxa o planejamento: quem olha a semana e quem decide
          o que fazer com "faltam 12 dias". Uma oitava secao no rail seria um
          lugar a mais para lembrar de visitar. */}
      <ListaDePrazos />

      {/* Matérias, pelo mesmo motivo de ListaDePrazos acima: não são da
          semana em exibição, são globais (o mesmo cadastro vale pra
          qualquer semana), então uma seção própria de rail seria um lugar a
          mais pra lembrar de visitar. Hoje o backend tem
          criar_materia/listar_materias/etc. e nenhuma tela os chamava —
          PainelDeMaterias é essa tela. */}
      <PainelDeMaterias />
    </div>
  );
}
