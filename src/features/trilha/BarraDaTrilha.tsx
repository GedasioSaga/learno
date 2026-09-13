import { useEffect, useState, type FormEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import type { EtapaDaTrilha, FlechaDaTrilha, RaiaDaTrilha, Trilha } from "../../lib/ipc";
import { duracaoDoMovimentoDoCanvas } from "./ControlesDoCanvas";
import type { PosicaoDaEtapa } from "./layout";
import { useTrilhaStore } from "./store";

/**
 * A trava do item 3 do pedido, aberta: sem `groupPropertyId`, a trilha não
 * tem "onde" nomear uma raia (`criar_raia`/`renomear_raia` recusariam), e
 * antes desta entrega não havia como configurá-lo depois da criação. Só
 * aparece quando `configuracao.groupPropertyId` é `null` — com uma
 * propriedade já configurada, o formulário abaixo (`FormularioDeNovaRaia`)
 * assume o lugar dela.
 */
function BotaoDeAtivarRaias() {
  const ativarRaias = useTrilhaStore((state) => state.ativarRaias);
  const [ativando, setAtivando] = useState(false);

  async function handleClick() {
    setAtivando(true);
    await ativarRaias();
    setAtivando(false);
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={ativando}
      className="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 disabled:opacity-50 motion-reduce:transition-none"
    >
      {ativando ? "Ativando raias…" : "Ativar raias"}
    </button>
  );
}

function FormularioDeNovaRaia() {
  const [nome, setNome] = useState("");
  const criarRaia = useTrilhaStore((state) => state.criarRaia);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const valor = nome.trim();
    if (!valor) return;
    void criarRaia(valor);
    setNome("");
  }

  return (
    <form onSubmit={handleSubmit} className="trilha-barra__formulario">
      <label htmlFor="trilha-nome-da-nova-raia" className="sr-only">
        Nome da nova raia
      </label>
      <input
        id="trilha-nome-da-nova-raia"
        type="text"
        value={nome}
        onChange={(event) => setNome(event.currentTarget.value)}
        placeholder="Nova raia"
        className="trilha-barra__campo w-28"
      />
      <button type="submit" disabled={nome.trim().length === 0} className="trilha-barra__enviar">
        + Raia
      </button>
    </form>
  );
}

/**
 * BUG REAL (relatado pelo usuário), corrigido aqui na origem: com a trilha
 * já tendo raia nomeada, `laneValue` fixo em `""` fazia a etapa nascer ÓRFÃ
 * — e o único controle que a resgataria ("Mover para raia") vive no cartão
 * da própria etapa, que `layout.ts` deixava fora de toda faixa e por isso
 * nunca chegava a ser desenhado. A suposição original (comentário removido)
 * era que isso não importava porque o cartão estaria visível — não estava.
 *
 * Duas camadas: esta (formulário) evita criar a órfã; `layout.ts` garante
 * que, mesmo se uma nascer (registro antigo, ou trilha sem raia nenhuma),
 * ela sempre tem uma faixa visível para cair.
 *
 * O padrão agora é uma raia REAL sempre que existir alguma nomeada — nunca
 * vazio por default. Só permanece vazio (TRL-014, estado válido) quando a
 * trilha não tem raia nomeada nenhuma; aí não há entre o quê escolher, e o
 * seletor nem aparece.
 */
function FormularioDeNovaEtapa({ raias }: { raias: RaiaDaTrilha[] }) {
  const raiasNomeadas = raias.filter((raia) => raia.laneValue.trim().length > 0);
  const [titulo, setTitulo] = useState("");
  const [laneValue, setLaneValue] = useState(raiasNomeadas[0]?.laneValue ?? "");
  const criarEtapa = useTrilhaStore((state) => state.criarEtapa);

  // Acompanha a lista de raias (ex.: a primeira raia nasce depois deste
  // formulário já estar montado) — sem isto, `laneValue` ficaria preso em
  // "" mesmo depois de existir raia para escolher. Sem array de
  // dependências de propósito: `raiasNomeadas` é recriado a cada render (é
  // um `.filter()` de uma prop), então listar como dependência rodaria o
  // efeito toda vez de qualquer forma — o `if` interno é quem evita o loop
  // (só chama `setLaneValue` quando o valor de fato muda).
  useEffect(() => {
    if (raiasNomeadas.length === 0) return;
    if (!raiasNomeadas.some((raia) => raia.laneValue === laneValue)) setLaneValue(raiasNomeadas[0].laneValue);
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const valor = titulo.trim();
    if (!valor) return;
    void criarEtapa(valor, laneValue);
    setTitulo("");
  }

  return (
    <form onSubmit={handleSubmit} className="trilha-barra__formulario">
      <label htmlFor="trilha-titulo-da-nova-etapa" className="sr-only">
        Título da nova etapa
      </label>
      <input
        id="trilha-titulo-da-nova-etapa"
        type="text"
        value={titulo}
        onChange={(event) => setTitulo(event.currentTarget.value)}
        placeholder="Nova etapa"
        className="trilha-barra__campo w-36"
      />
      {raiasNomeadas.length > 0 ? (
        <>
          <label htmlFor="trilha-raia-da-nova-etapa" className="sr-only">
            Raia da nova etapa
          </label>
          <select
            id="trilha-raia-da-nova-etapa"
            value={laneValue}
            onChange={(event) => setLaneValue(event.currentTarget.value)}
            className="trilha-barra__campo w-24"
          >
            {raiasNomeadas.map((raia) => (
              <option key={raia.laneValue} value={raia.laneValue}>
                {raia.laneValue}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <button type="submit" disabled={titulo.trim().length === 0} className="trilha-barra__enviar">
        + Etapa
      </button>
    </form>
  );
}

/**
 * "Continue em: …" — a resposta persistente ao "o que eu faço agora?"
 * (item 1 do pedido). `setCenter` leva o canvas até o cartão em zoom de
 * leitura; o foco vai junto (o wrapper do nó é focável pelo `@xyflow`),
 * para quem navega por teclado cair exatamente na etapa e não só ver o
 * canvas rolar. Sem etapa recomendada a frase diz o porquê em vez de sumir:
 * "tudo concluído" e "só sobrou bloqueada" são respostas, não ausência.
 */
function ProximoPasso({
  etapa,
  posicao,
  nomeDaRaia,
  totalEtapas,
  concluidas,
}: {
  etapa: EtapaDaTrilha | null;
  posicao: PosicaoDaEtapa | null;
  nomeDaRaia: string | null;
  totalEtapas: number;
  concluidas: number;
}) {
  const { setCenter } = useReactFlow();

  function irAteLa() {
    if (!etapa || !posicao) return;
    void setCenter(posicao.x + posicao.width / 2, posicao.y + posicao.height / 2, { zoom: 1, duration: duracaoDoMovimentoDoCanvas() }).then(() => {
      const wrapper = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${etapa.id}"]`);
      wrapper?.focus({ preventScroll: true });
    });
  }

  if (!etapa) {
    const mensagem =
      totalEtapas === 0
        ? "Crie a primeira etapa para começar."
        : concluidas === totalEtapas
          ? "Tudo concluído."
          : "Nada disponível agora — o que resta está bloqueado ou em ciclo.";
    return <p className="trilha-barra__agora text-ink-muted">{mensagem}</p>;
  }

  return (
    <div className="trilha-barra__agora">
      <span className="trilha-barra__agora-rotulo">{etapa.state === "in_progress" ? "Continue em" : "Comece por"}</span>
      <span className="trilha-barra__agora-titulo">{etapa.title}</span>
      {nomeDaRaia ? <span className="trilha-barra__agora-raia">{nomeDaRaia}</span> : null}
      <button type="button" onClick={irAteLa} className="trilha-barra__ir">
        Ir até lá
      </button>
    </div>
  );
}

/**
 * O aviso de ciclo, como FAIXA do cabeçalho (item 5 do pedido) em vez de
 * painel flutuante sobre o canvas — um ciclo é uma condição da trilha
 * inteira, não de um ponto do desenho, e flutuando ele tapava o rótulo de
 * nível. Mesmo conteúdo e mesmos botões de antes: apagar uma flecha do
 * ciclo continua sendo a saída, e continua a um clique.
 */
function FaixaDeCiclo({ etapasEmCiclo, flechasDoCiclo, todasEtapas }: { etapasEmCiclo: EtapaDaTrilha[]; flechasDoCiclo: FlechaDaTrilha[]; todasEtapas: EtapaDaTrilha[] }) {
  const apagarFlecha = useTrilhaStore((state) => state.apagarFlecha);
  const tituloDe = (id: string) => todasEtapas.find((etapa) => etapa.id === id)?.title ?? id;

  return (
    <div role="alert" className="trilha-barra__ciclo">
      <p className="font-medium">
        Ciclo de dependência: {etapasEmCiclo.map((etapa) => etapa.title).join(", ")}. Uma etapa em ciclo nunca desbloqueia sozinha —
        apague uma das flechas:
      </p>
      <ul className="trilha-barra__ciclo-lista">
        {flechasDoCiclo.map((flecha) => (
          <li key={`${flecha.blockingId}->${flecha.blockedId}`} className="flex items-center gap-2">
            <span className="truncate">
              {tituloDe(flecha.blockingId)} → {tituloDe(flecha.blockedId)}
            </span>
            <button type="button" onClick={() => void apagarFlecha(flecha.blockedId, flecha.blockingId)} className="trilha-barra__ciclo-apagar">
              Apagar esta flecha
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * O cabeçalho fixo da Trilha, ACIMA do canvas (não um `<Panel>` dentro
 * dele): progresso geral, o próximo passo, e os formulários de criar etapa
 * e raia — que antes flutuavam soltos no canto do canvas, por cima do
 * cabeçalho da primeira raia, com cara de depuração (item 4 do pedido).
 * Precisa estar dentro de um `ReactFlowProvider` (`useReactFlow` em
 * `ProximoPasso`), o que `ConteudoDeTrilha.tsx` já garante.
 */
export function BarraDaTrilha({
  trilha,
  proximaEtapa,
  posicaoDaProxima,
}: {
  trilha: Trilha;
  proximaEtapa: EtapaDaTrilha | null;
  posicaoDaProxima: PosicaoDaEtapa | null;
}) {
  const totalEtapas = trilha.etapas.length;
  const concluidas = trilha.etapas.filter((etapa) => etapa.state === "done").length;
  const percentual = totalEtapas === 0 ? 0 : Math.round((concluidas / totalEtapas) * 100);

  const etapasEmCiclo = trilha.etapas.filter((etapa) => etapa.inCycle);
  const flechasDoCiclo = trilha.flechas.filter(
    (flecha) => etapasEmCiclo.some((etapa) => etapa.id === flecha.blockedId) && etapasEmCiclo.some((etapa) => etapa.id === flecha.blockingId),
  );

  const nomeDaRaia = proximaEtapa && proximaEtapa.laneValue.trim().length > 0 ? proximaEtapa.laneValue : null;

  return (
    <header className="trilha-barra">
      <div className="trilha-barra__linha">
        <div className="trilha-barra__progresso" aria-label={`${concluidas} de ${totalEtapas} etapas concluídas`}>
          <span className="trilha-barra__progresso-texto">
            <strong>{concluidas}</strong> de {totalEtapas} concluídas
          </span>
          <span className="trilha-barra__progresso-trilho" aria-hidden="true">
            <span className="trilha-barra__progresso-cheio" style={{ width: `${percentual}%` }} />
          </span>
        </div>

        <ProximoPasso etapa={proximaEtapa} posicao={posicaoDaProxima} nomeDaRaia={nomeDaRaia} totalEtapas={totalEtapas} concluidas={concluidas} />

        <div className="trilha-barra__acoes">
          <FormularioDeNovaEtapa raias={trilha.raias} />
          {trilha.configuracao.groupPropertyId === null ? <BotaoDeAtivarRaias /> : <FormularioDeNovaRaia />}
        </div>
      </div>

      {etapasEmCiclo.length > 0 ? <FaixaDeCiclo etapasEmCiclo={etapasEmCiclo} flechasDoCiclo={flechasDoCiclo} todasEtapas={trilha.etapas} /> : null}
    </header>
  );
}
