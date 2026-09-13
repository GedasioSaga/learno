import type { EstadoVisualDaEtapa } from "./descricoes";

/** Ordem de leitura: do que já passou para o que ainda trava — a mesma ordem do olho na trilha. */
const ORDEM_DA_LEGENDA: { estado: EstadoVisualDaEtapa; rotulo: string }[] = [
  { estado: "concluida", rotulo: "Concluída" },
  { estado: "em-andamento", rotulo: "Em andamento" },
  { estado: "disponivel", rotulo: "Disponível" },
  { estado: "bloqueada", rotulo: "Bloqueada" },
  { estado: "em-ciclo", rotulo: "Em ciclo" },
];

const CLASSE_DA_MARCA: Record<EstadoVisualDaEtapa, string> = {
  disponivel: "trilha-etapa--disponivel",
  bloqueada: "trilha-etapa--bloqueada",
  "em-andamento": "trilha-etapa--em-andamento",
  concluida: "trilha-etapa--concluida",
  "em-ciclo": "trilha-etapa--em-ciclo",
};

/**
 * A chave de leitura dos estados (item 6 do pedido). Cada marca é o MESMO
 * `::before` do cartão — as classes `trilha-etapa--<estado>` só trocam
 * variáveis (trilha.css), então a legenda reaproveita-as e nunca pode
 * divergir do desenho de verdade. Só lista o que existe NESTA trilha: uma
 * trilha sem ciclo não precisa explicar o que é um ciclo.
 */
export function LegendaDaTrilha({ estadosPresentes, temMarco }: { estadosPresentes: ReadonlySet<EstadoVisualDaEtapa>; temMarco: boolean }) {
  const itens = ORDEM_DA_LEGENDA.filter((item) => estadosPresentes.has(item.estado));
  if (itens.length === 0 && !temMarco) return null;

  return (
    <ul className="trilha-legenda" aria-label="Legenda dos estados">
      {itens.map((item) => (
        <li key={item.estado} className="trilha-legenda__item">
          <span aria-hidden="true" className={`trilha-legenda__marca ${CLASSE_DA_MARCA[item.estado]}`} />
          {item.rotulo}
        </li>
      ))}
      {temMarco ? (
        <li className="trilha-legenda__item">
          <span aria-hidden="true" className="trilha-legenda__faixa-de-marco" />
          Marco: junta vários pré-requisitos
        </li>
      ) : null}
    </ul>
  );
}
