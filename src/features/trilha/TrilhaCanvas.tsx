import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  useReactFlow,
  type CoordinateExtent,
  type OnConnect,
  type OnDelete,
  type OnEdgesChange,
  type OnNodeDrag,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./trilha.css";
import type { Trilha } from "../../lib/ipc";
import { useCartoesStore } from "../cartoes/store";
import { usePageTreeStore } from "../pages/store";
import {
  alvoDeReordenacaoNaRaia,
  laneParaMover,
  posicaoComXTravado,
  raiaAlvoNoY,
  yDaLinhaDeInsercao,
  type AlvoDeReordenacao,
  type CartaoIrmaoParaReordenar,
} from "./arrasto-de-raia";
import { BarraDaTrilha } from "./BarraDaTrilha";
import { ControlesDoCanvas } from "./ControlesDoCanvas";
import { mapaDeCoresDasRaias, type CorDeRaia } from "./cores-de-raia";
import { descricaoParaLeitorDeTela, estadoVisualDaEtapa, type EstadoVisualDaEtapa } from "./descricoes";
import { EtapaNode } from "./EtapaNode";
import { FundoDeNiveisNode } from "./FundoDeNiveisNode";
import { calcularLayoutDaTrilha, GAP_LINHA, laneEfetivaDaEtapa, ordenarRaiasParaExibicao, type PosicaoDaEtapa, type ResultadoDoLayout } from "./layout";
import { LegendaDaTrilha } from "./LegendaDaTrilha";
import { argumentosDeCriarFlecha, estadoDaFlecha, rotuloDeExibicao, type EstadoDaFlecha } from "./ligacao";
import { LinhaDeInsercaoNode } from "./LinhaDeInsercaoNode";
import { cadeiaDeDependencias, contarPreRequisitos, ehMarco, enquadramentoInicial, proximaEtapaRecomendada } from "./orientacao";
import { RaiaNode } from "./RaiaNode";
import { useTrilhaStore } from "./store";
import type { FlechaDoCanvas, NoDeEtapa, NoDeFundo, NoDeLinhaDeInsercao, NoDeRaia, NoDoCanvas } from "./tipos-do-canvas";

/** Fora do componente: identidade estável entre renders (mesmo motivo do `TIPOS_DE_NO` de `ConteudoDeMapaMental.tsx`). */
const TIPOS_DE_NO = {
  trilhaEtapa: EtapaNode,
  trilhaRaia: RaiaNode,
  trilhaFundo: FundoDeNiveisNode,
  trilhaLinhaDeInsercao: LinhaDeInsercaoNode,
};

/** Id fixo do nó de linha de inserção — só existe um por vez (`linhaDeInsercao`, estado de `TrilhaCanvas`). */
const ID_DA_LINHA_DE_INSERCAO = "trilha-linha-de-insercao";

/**
 * Quanto o canvas deixa arrastar ALÉM do conteúdo, em px do canvas. Antes
 * não havia limite: era possível arrastar a trilha inteira para fora da
 * tela e ficar olhando para o vazio (o "espaço morto" do item 7). Folga
 * generosa de propósito — o limite é para não se perder, não para
 * prender.
 */
const FOLGA_DE_ARRASTO = 480;

/**
 * Ao tirar o mouse de um cartão, a cadeia realçada espera este tanto antes
 * de apagar. Sem isto, passar de um cartão para o vizinho apagava e
 * reacendia o canvas inteiro no meio do caminho — pisca. Entrar é
 * imediato: o mouse já está lá.
 */
const ATRASO_PARA_APAGAR_CADEIA_MS = 100;

function construirNos(trilha: Trilha, layout: ResultadoDoLayout, cores: Map<string, CorDeRaia>, idDaProxima: string | null): NoDoCanvas[] {
  const fundo: NoDeFundo = {
    id: "trilha-fundo",
    type: "trilhaFundo",
    position: { x: 0, y: 0 },
    style: { width: layout.largura, height: layout.altura },
    selectable: false,
    focusable: false,
    draggable: false,
    deletable: false,
    zIndex: 0,
    data: { totalNiveis: layout.totalNiveis },
  };

  // MESMA ordem que `calcularLayoutDaTrilha` usou para gerar `layout.faixas`
  // — zip por índice em vez de procurar por `laneValue`, para as duas listas
  // nunca poderem discordar uma da outra. Inclui a faixa sintética "Sem
  // raia" quando há etapa órfã (`ordenarRaiasParaExibicao`, layout.ts) — por
  // isso a contagem de `etapasDaRaia` usa `laneEfetivaDaEtapa`, não
  // `etapa.laneValue` puro: uma etapa órfã precisa contar na faixa "Sem
  // raia", nunca em faixa nenhuma.
  const raiasOrdenadas = ordenarRaiasParaExibicao(trilha.etapas, trilha.raias);
  const nosDeRaia: NoDeRaia[] = layout.faixas.map((faixa, indice) => {
    const raia = raiasOrdenadas[indice];
    const etapasDaRaia = trilha.etapas.filter((etapa) => laneEfetivaDaEtapa(etapa, trilha.raias) === faixa.laneValue);
    return {
      id: `trilha-raia-${faixa.laneValue || "sem-nome"}`,
      type: "trilhaRaia",
      position: { x: 0, y: faixa.y },
      style: { width: layout.largura, height: faixa.height },
      selectable: false,
      focusable: false,
      draggable: false,
      deletable: false,
      zIndex: 0,
      data: {
        raia,
        cor: cores.get(faixa.laneValue) ?? null,
        totalEtapas: etapasDaRaia.length,
        concluidas: etapasDaRaia.filter((etapa) => etapa.state === "done").length,
      },
    };
  });

  const nosDeEtapa: NoDeEtapa[] = trilha.etapas
    .map((etapa) => {
      const posicao = layout.posicoes.get(etapa.id);
      // Defensivo: `calcularLayoutDaTrilha` itera exatamente `trilha.etapas`,
      // então toda etapa tem posição — mas nunca afirmar isso com `!` quando
      // um `if` resolve sem custo.
      if (!posicao) return null;
      const marco = ehMarco(etapa.id, trilha.flechas);
      const proxima = etapa.id === idDaProxima;
      // O `aria-label` do wrapper é o que o leitor de tela anuncia no nó —
      // os dois pesos de orientação entram aqui em texto, não só no selo e
      // na bandeira desenhados dentro do cartão.
      const descricao = [
        descricaoParaLeitorDeTela(etapa, trilha.etapas, trilha.flechas, trilha.decisoes),
        marco ? `Marco: junta ${contarPreRequisitos(etapa.id, trilha.flechas)} pré-requisitos.` : null,
        proxima ? "Próximo passo recomendado." : null,
      ]
        .filter(Boolean)
        .join(" ");
      const no: NoDeEtapa = {
        id: etapa.id,
        type: "trilhaEtapa",
        position: { x: posicao.x, y: posicao.y },
        hidden: !posicao.visivel,
        // `draggable: true` só aqui (raia e fundo continuam `false`, acima):
        // arrastar um cartão para OUTRA RAIA é o item 3 do pedido — o
        // `nodesDraggable={false}` do `<ReactFlow>` continua valendo como
        // padrão global (raia/fundo não têm `draggable` próprio e herdariam
        // `false` dali), mas o valor por nó sempre vence o global
        // (`getDragItems` em `@xyflow/system`). O eixo X continua travado:
        // `handleNodesChange`, abaixo, reescreve todo `position.x` de um
        // cartão de volta ao valor do layout antes de aplicar a mudança —
        // só a raia (vertical) é de fato livre.
        draggable: true,
        deletable: false,
        ariaLabel: descricao,
        zIndex: 1,
        data: { etapa, cor: cores.get(etapa.laneValue) ?? null, marco, proxima },
      };
      return no;
    })
    .filter((no): no is NoDeEtapa => no !== null);

  return [fundo, ...nosDeRaia, ...nosDeEtapa];
}

/**
 * Cor do TRAÇO e da PONTA de uma flecha, e a classe modificadora que muda o
 * traço — regra completa em docs/DESIGN-TRILHA.md §4. `alvo` é quem depende
 * (a etapa bloqueada); a cor de base é sempre a da raia dele.
 *
 * LIMITAÇÃO ASSUMIDA sobre "em ciclo": o backend só marca `inCycle` por
 * ETAPA, não por flecha — não há como saber, só com o que `obterTrilha`
 * devolve, qual aresta especificamente "fecha" um ciclo de N etapas. Uma
 * flecha entre duas etapas que estão AMBAS em ciclo é tratada como parte do
 * ciclo; isso pode marcar de mais se o grafo tiver dois ciclos distintos
 * ligados por uma flecha comum a ambos — caso raro, e ainda assim a flecha
 * continua apagável (o objetivo do item 5 do pedido) mesmo se a pintura for
 * imprecisa nesse cenário específico.
 */
function classeECorDaFlecha(
  alvo: Trilha["etapas"][number] | undefined,
  origem: Trilha["etapas"][number] | undefined,
  corDoAlvo: CorDeRaia | null,
  estado: EstadoDaFlecha,
) {
  const classes = ["trilha-aresta"];
  if (corDoAlvo) classes.push(`trilha-cor--${corDoAlvo}`);
  let cor = corDoAlvo ? `var(--raia-${corDoAlvo})` : "var(--border)";

  if (alvo && estadoVisualDaEtapa(alvo) === "concluida") {
    classes.push("trilha-aresta--para-concluida");
    cor = "var(--mint)";
  } else if (alvo?.inCycle && origem?.inCycle) {
    classes.push("trilha-aresta--em-ciclo");
    cor = "var(--terracotta)";
  } else if (alvo && estadoVisualDaEtapa(alvo) === "bloqueada") {
    classes.push("trilha-aresta--para-bloqueada");
  }

  // Eixo ORTOGONAL ao de cima (trilha.css explica por que só mexe em
  // tracejado/opacidade, nunca em `cor`): viva não precisa de classe própria
  // (é o traço padrão); morta e esperando, sim — nunca só cor (item 2).
  if (estado === "morta") classes.push("trilha-aresta--morta");
  else if (estado === "esperando") classes.push("trilha-aresta--esperando");

  return { className: classes.join(" "), cor };
}

/**
 * Os "irmãos" de uma etapa para fins de reordenação: MESMA raia efetiva,
 * MESMO nível (a coluna nunca muda — X travado), excluindo ela mesma. `y` é
 * o CENTRO do cartão como `layout` desenhou agora (mesmo espaço de
 * `layout.posicoes`) — a régua que decide onde o cartão em voo caiu; `posicaoOriginal`
 * de cada irmão não muda durante o arrasto (só o cartão arrastado se move na
 * tela), então isto é seguro de recalcular a cada quadro.
 */
function irmaosParaReordenar(trilha: Trilha, layout: ResultadoDoLayout, etapaArrastada: Trilha["etapas"][number]): CartaoIrmaoParaReordenar[] {
  const laneDaArrastada = laneEfetivaDaEtapa(etapaArrastada, trilha.raias);
  const irmaos: CartaoIrmaoParaReordenar[] = [];
  for (const etapa of trilha.etapas) {
    if (etapa.id === etapaArrastada.id) continue;
    if (etapa.level !== etapaArrastada.level) continue;
    if (laneEfetivaDaEtapa(etapa, trilha.raias) !== laneDaArrastada) continue;
    const posicao = layout.posicoes.get(etapa.id);
    if (!posicao) continue;
    irmaos.push({ id: etapa.id, position: etapa.position, y: posicao.y + posicao.height / 2 });
  }
  return irmaos;
}

function construirArestas(trilha: Trilha, cores: Map<string, CorDeRaia>): FlechaDoCanvas[] {
  const etapaPorId = new Map(trilha.etapas.map((etapa) => [etapa.id, etapa]));

  return trilha.flechas.map((flecha): FlechaDoCanvas => {
    const alvo = etapaPorId.get(flecha.blockedId);
    const origem = etapaPorId.get(flecha.blockingId);
    const corDoAlvo = alvo ? (cores.get(alvo.laneValue) ?? null) : null;
    const estado = estadoDaFlecha(flecha, trilha.decisoes);
    const { className, cor } = classeECorDaFlecha(alvo, origem, corDoAlvo, estado);

    return {
      id: `${flecha.blockingId}->${flecha.blockedId}`,
      source: flecha.blockingId,
      target: flecha.blockedId,
      type: "smoothstep",
      className,
      // `undefined` (não string vazia) quando não há rótulo — o `<EdgeText>`
      // da lib só deixa de renderizar o grupo inteiro (fundo + texto) para um
      // `label` falsy (ver o `.d.ts` instalado); string vazia passaria.
      label: rotuloDeExibicao(flecha.pathLabel),
      pathOptions: { borderRadius: 12 },
      deletable: true,
      data: { blockedId: flecha.blockedId, blockingId: flecha.blockingId },
      markerEnd: { type: MarkerType.ArrowClosed, width: 22, height: 22, markerUnits: "userSpaceOnUse", strokeWidth: 1.5, color: cor },
    };
  });
}

/**
 * Aparece só quando `handleConnect` (abaixo) detecta que a conexão em voo sai
 * de uma DECISÃO — item 3 do pedido: "arrastar de uma decisão cria uma
 * flecha COM rótulo, e o usuário precisa poder dizer qual". Decisão de
 * design: perguntar NA HORA, com uma sugestão pré-preenchida
 * (`proximoRotuloDeCaminho`, em `ligacao.ts`) que o usuário aceita ou troca —
 * nunca cria com `null` para "nomear depois", porque o contrato não expõe
 * nenhum comando para dar nome a uma flecha que já nasceu sem um
 * (`renomearCaminho` RENOMEIA um caminho existente, não nomeia um `null`).
 */
function FormularioDeRotuloDoCaminho({
  sugestao,
  onConfirmar,
  onCancelar,
}: {
  sugestao: string;
  onConfirmar: (rotulo: string) => void;
  onCancelar: () => void;
}) {
  const [rotulo, setRotulo] = useState(sugestao);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const valor = rotulo.trim();
    onConfirmar(valor || sugestao);
  }

  return (
    <form
      onSubmit={handleSubmit}
      role="dialog"
      aria-label="Nomear o novo caminho"
      className="flex items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1.5 shadow-hard-sm"
    >
      <label htmlFor="trilha-rotulo-do-caminho" className="sr-only">
        Nome do caminho
      </label>
      <input
        id="trilha-rotulo-do-caminho"
        type="text"
        value={rotulo}
        onChange={(event) => setRotulo(event.currentTarget.value)}
        autoFocus
        className="w-40 rounded-sm border border-border bg-paper px-2 py-1 text-sm text-ink outline-none"
      />
      <button
        type="submit"
        className="shrink-0 rounded-sm bg-emerald px-2 py-1 text-xs font-medium text-on-emerald transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
      >
        Criar caminho
      </button>
      <button
        type="button"
        onClick={onCancelar}
        className="shrink-0 rounded-sm border border-border px-2 py-1 text-xs font-medium text-ink transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
      >
        Cancelar
      </button>
    </form>
  );
}

/**
 * O canvas em si — montado por `ConteudoDeTrilha.tsx` só quando `trilha` já
 * está carregada. Nós/arestas do `@xyflow/react` são estado LOCAL
 * (`useState`), reconstruído do zero a cada `trilha` nova (item 3 do pedido:
 * "as posições são CALCULADAS a cada leitura, nunca gravadas") e só então
 * mutado localmente por `onNodesChange`/`onEdgesChange` — que cobrem seleção,
 * a medição de dimensão que o próprio `@xyflow` dispara, e agora também
 * posição: um cartão de etapa pode ser arrastado para OUTRA RAIA (a raia é
 * livre, ver `RaiaNode`/`moverEtapaParaRaia`), mas o NÍVEL (coluna, eixo X)
 * continua fixo — é dependência, não lugar (`layout.ts` §1). `handleNodesChange`
 * trava o X de todo cartão a cada mudança de posição, e `handleNodeDragStop`
 * decide, ao soltar, se o gesto vira uma chamada de IPC (`arrasto-de-raia.ts`
 * tem a lógica pura dessa decisão — testável sem simular um drag em DOM).
 * Raia e fundo continuam com `draggable: false`: só a coluna de etapas se
 * move.
 */
export function TrilhaCanvas() {
  const trilha = useTrilhaStore((state) => state.trilha);
  const errorMessage = useTrilhaStore((state) => state.errorMessage);
  const criarFlecha = useTrilhaStore((state) => state.criarFlecha);
  const apagarFlecha = useTrilhaStore((state) => state.apagarFlecha);
  const moverEtapaParaRaia = useTrilhaStore((state) => state.moverEtapaParaRaia);
  const reordenarEtapa = useTrilhaStore((state) => state.reordenarEtapa);
  const statusDasPaginas = usePageTreeStore((state) => state.status);
  const carregarPaginas = usePageTreeStore((state) => state.load);
  const statusDosBaralhos = useCartoesStore((state) => state.status);
  const carregarBaralhos = useCartoesStore((state) => state.load);

  const { setViewport } = useReactFlow();

  const [nodes, setNodes] = useState<NoDoCanvas[]>([]);
  const [edges, setEdges] = useState<FlechaDoCanvas[]>([]);
  // Conexão em voo que saiu de uma decisão, esperando o usuário nomear o
  // caminho antes de `criarFlecha` de fato rodar — ver `FormularioDeRotuloDoCaminho`.
  const [conexaoPendente, setConexaoPendente] = useState<{ blockedId: string; blockingId: string; sugestao: string } | null>(null);
  /** A etapa sob o mouse — a cadeia dela é realçada (item 2 do pedido). `null` fora de qualquer cartão. */
  const [etapaSobOMouse, setEtapaSobOMouse] = useState<string | null>(null);
  /**
   * A raia sob o cartão em arrasto AGORA — `null` sempre que não há arrasto
   * em voo, ou quando o ponto está fora de qualquer raia, ou sobre uma raia
   * recolhida (`raiaAlvoNoY` recusa as duas coisas, ver `arrasto-de-raia.ts`).
   * `""` é um valor válido aqui (a faixa "Sem raia"), por isso o tipo não
   * reaproveita `null` para os dois sentidos — só ausência de arrasto/alvo é
   * `null`. `nosComCadeia`, abaixo, usa isto para destacar a faixa certa: o
   * usuário não pode ter que adivinhar em qual raia o cartão vai cair.
   */
  const [raiaAlvoDoArrasto, setRaiaAlvoDoArrasto] = useState<string | null>(null);
  /**
   * A linha de inserção do arrasto de REORDENAÇÃO (soltar na MESMA raia do
   * cartão em voo) — `null` sempre que não há arrasto em voo, quando o
   * cartão está sobre OUTRA raia (aquele caso já tem o próprio destaque, o
   * de `raiaAlvoDoArrasto` acima) ou quando a raia atual não tem nenhum
   * outro cartão no mesmo nível para comparar. `nosComCadeia`, abaixo,
   * monta o nó `trilhaLinhaDeInsercao` só quando isto não é `null`.
   */
  const [linhaDeInsercao, setLinhaDeInsercao] = useState<{ x: number; y: number; largura: number } | null>(null);
  const apagarCadeiaAgendado = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  /** O layout da trilha atual — `ControlesDoCanvas`/`BarraDaTrilha` precisam da posição da próxima etapa, e o enquadramento precisa das dimensões. */
  const [layout, setLayout] = useState<ResultadoDoLayout | null>(null);
  /** `viewId` que já recebeu o enquadramento inicial — uma vez por trilha aberta, nunca a cada releitura (marcar progresso não pode fazer o canvas pular). */
  const viewIdEnquadrado = useRef<string | null>(null);
  const [canvasPronto, setCanvasPronto] = useState(false);

  // O seletor de "anexar material" de cada `EtapaNode` precisa da árvore de
  // páginas (`usePageTreeStore`) — que, ao contrário desta seção, só carrega
  // sozinha quando Notas monta (`PageTree.tsx`). Sem isto, abrir a Trilha
  // sem nunca ter aberto Notas deixaria o seletor sempre vazio. Guardado por
  // `status === "idle"` para não recarregar a cada nó/render — uma vez por
  // sessão da tela basta.
  useEffect(() => {
    if (statusDasPaginas === "idle") void carregarPaginas();
  }, [statusDasPaginas, carregarPaginas]);

  // Mesmo motivo e mesma guarda do efeito acima, agora para o seletor de
  // "anexar baralho" de cada `EtapaNode`: `useCartoesStore` só carrega
  // sozinho quando a seção Cartões monta (`DeckTree.tsx`/`ConteudoDeCartoes`).
  // Sem isto, abrir a Trilha sem nunca ter aberto Cartões deixaria a lista de
  // baralhos sempre vazia — o mesmo bug de "não dá para colocar card" que
  // esta entrega corrige, só que na origem da lista em vez de no formulário.
  useEffect(() => {
    if (statusDosBaralhos === "idle") void carregarBaralhos();
  }, [statusDosBaralhos, carregarBaralhos]);

  const proximaEtapa = useMemo(() => (trilha ? proximaEtapaRecomendada(trilha.etapas, trilha.raias) : null), [trilha]);

  useEffect(() => {
    if (!trilha) {
      setNodes([]);
      setEdges([]);
      setLayout(null);
      return;
    }
    const layoutNovo = calcularLayoutDaTrilha(trilha.etapas, trilha.flechas, trilha.raias);
    const cores = mapaDeCoresDasRaias(trilha.etapas, trilha.raias);
    setNodes(construirNos(trilha, layoutNovo, cores, proximaEtapa?.id ?? null));
    setEdges(construirArestas(trilha, cores));
    setLayout(layoutNovo);
  }, [trilha, proximaEtapa]);

  // Enquadramento inicial (item 7 do pedido): substitui o `fitView` da lib,
  // que rodava antes de os nós existirem (eles nascem no efeito acima) e
  // que, quando rodava, encolhia tudo até caber — texto miúdo. Aqui o
  // canvas abre no maior zoom em que tudo cabe, mas nunca abaixo do
  // legível; ver `enquadramentoInicial`. Roda uma vez por `viewId`, quando
  // o `<ReactFlow>` já está montado (`canvasPronto`) e o layout já existe.
  useEffect(() => {
    if (!canvasPronto || !layout || !trilha) return;
    const viewId = trilha.configuracao.viewId;
    if (viewIdEnquadrado.current === viewId) return;
    const tela = { largura: canvasRef.current?.clientWidth ?? 0, altura: canvasRef.current?.clientHeight ?? 0 };
    if (tela.largura === 0 || tela.altura === 0) return;
    viewIdEnquadrado.current = viewId;
    void setViewport(enquadramentoInicial({ largura: layout.largura, altura: layout.altura }, tela));
  }, [canvasPronto, layout, trilha, setViewport]);

  const handleNodesChange = useCallback<OnNodesChange<NoDoCanvas>>(
    (changes) => {
      // Trava o eixo X aqui, ANTES de `applyNodeChanges` — não só ao soltar
      // (`handleNodeDragStop`, abaixo): sem isto o cartão visivelmente
      // escorregaria para os lados durante o próprio arrasto, porque toda
      // mudança de posição (inclusive as intermediárias de um drag em
      // andamento) passa por aqui. `layout.posicoes` só tem entrada para nós
      // de ETAPA (raia/fundo não têm `draggable`, então nunca geram mudança
      // de posição de qualquer forma) — por isso o `?.` não precisa de mais
      // guarda: sem entrada, a mudança segue como veio.
      const comXTravado = changes.map((mudanca) => {
        if (mudanca.type !== "position" || !mudanca.position) return mudanca;
        const posicaoOriginal = layout?.posicoes.get(mudanca.id);
        if (!posicaoOriginal) return mudanca;
        return { ...mudanca, position: posicaoComXTravado(posicaoOriginal.x, mudanca.position.y) };
      });
      setNodes((atuais) => applyNodeChanges(comXTravado, atuais));
    },
    [layout],
  );

  const handleEdgesChange = useCallback<OnEdgesChange<FlechaDoCanvas>>((changes) => {
    setEdges((atuais) => applyEdgeChanges(changes, atuais));
  }, []);

  /**
   * Chama a mutação e, só se ela FALHAR, reverte a posição visual na mão.
   *
   * Em sucesso, `executarEReler` (store.ts) troca a referência de `trilha` —
   * o `useEffect` que reconstrói `nodes`/`layout` a partir dela roda de novo
   * sozinho, com a posição definitiva da etapa já na raia nova (ela pode até
   * cair numa LINHA diferente da que o arrasto sugeria — `atribuirLinhas` em
   * `layout.ts` decide isso, não o gesto). Como o cartão já estava visualmente
   * onde foi solto, essa troca é um pulo DIRETO da posição-de-solto para a
   * posição-definitiva — nunca um pulo de volta à raia antiga no meio do
   * caminho, que é exatamente o "piscar" que o pedido veta.
   *
   * Em falha, `executarEReler` só grava `errorMessage` — `trilha` não muda de
   * referência, o efeito não roda de novo, e sem este `else` o cartão ficaria
   * congelado onde foi solto (visualmente na raia nova) mesmo a escrita não
   * tendo colado. Comparar a REFERÊNCIA (não reler `etapa.laneValue`) é o que
   * distingue sucesso de falha sem precisar de um valor de retorno que
   * `moverEtapaParaRaia` não tem (ela nunca rejeita — o catch já mora dentro
   * de `executarEReler`).
   */
  const moverParaRaiaEVerificar = useCallback(
    async (stepId: string, laneValue: string, posicaoOriginal: PosicaoDaEtapa) => {
      const trilhaAntes = useTrilhaStore.getState().trilha;
      await moverEtapaParaRaia(stepId, laneValue);
      if (useTrilhaStore.getState().trilha !== trilhaAntes) return;
      setNodes((atuais) =>
        atuais.map((no) => (no.id === stepId ? { ...no, position: { x: posicaoOriginal.x, y: posicaoOriginal.y } } : no)),
      );
    },
    [moverEtapaParaRaia],
  );

  /**
   * Mesmo padrão de `moverParaRaiaEVerificar` acima, para o outro desfecho
   * de soltar um cartão: reordenar DENTRO da mesma raia. `reordenarEtapa`
   * também nunca rejeita (o catch mora em `executarEReler`, store.ts) — só
   * comparar a REFERÊNCIA de `trilha` antes/depois distingue sucesso de
   * falha, sem precisar de valor de retorno nenhum.
   */
  const reordenarEVerificar = useCallback(
    async (stepId: string, alvo: AlvoDeReordenacao, posicaoOriginal: PosicaoDaEtapa) => {
      const trilhaAntes = useTrilhaStore.getState().trilha;
      await reordenarEtapa(stepId, alvo);
      if (useTrilhaStore.getState().trilha !== trilhaAntes) return;
      setNodes((atuais) =>
        atuais.map((no) => (no.id === stepId ? { ...no, position: { x: posicaoOriginal.x, y: posicaoOriginal.y } } : no)),
      );
    },
    [reordenarEtapa],
  );

  /**
   * A cada quadro do arrasto: decide qual raia destacar (`raiaAlvoDoArrasto`,
   * lido por `nosComCadeia` para pintar a `RaiaNode` certa) e, quando o
   * cartão continua sobre a PRÓPRIA raia, onde a linha de inserção cai
   * (`linhaDeInsercao`, item 3 do pedido — "não deixe o usuário adivinhar").
   * O X já chega travado por `handleNodesChange`, então só a altura do
   * cartão (do layout, não medida de novo) entra na conta do centro vertical.
   */
  const handleNodeDrag = useCallback<OnNodeDrag<NoDoCanvas>>(
    (_event, no) => {
      if (no.type !== "trilhaEtapa" || !layout || !trilha) return;
      const posicaoOriginal = layout.posicoes.get(no.id);
      if (!posicaoOriginal) return;
      const etapaArrastada = trilha.etapas.find((candidata) => candidata.id === no.id);
      if (!etapaArrastada) return;

      const centroY = no.position.y + posicaoOriginal.height / 2;
      const laneAlvo = raiaAlvoNoY(centroY, layout.faixas);
      setRaiaAlvoDoArrasto(laneAlvo);

      const laneAtual = laneEfetivaDaEtapa(etapaArrastada, trilha.raias);
      if (laneAlvo !== laneAtual) {
        // Sobre outra raia (ou fora de qualquer raia): quem já mostra o alvo
        // é o destaque da faixa acima — a linha de inserção é só para
        // reordenar dentro da MESMA raia, e some daqui.
        setLinhaDeInsercao(null);
        return;
      }

      const irmaos = irmaosParaReordenar(trilha, layout, etapaArrastada);
      if (irmaos.length === 0) {
        setLinhaDeInsercao(null);
        return;
      }
      const y = yDaLinhaDeInsercao(centroY, irmaos, posicaoOriginal.height, GAP_LINHA);
      setLinhaDeInsercao({ x: posicaoOriginal.x, y, largura: posicaoOriginal.width });
    },
    [layout, trilha],
  );

  /**
   * Ao soltar: primeiro decide a RAIA (mudar de faixa vence — é o
   * comportamento que já existia), e só quando o cartão fica na MESMA raia
   * tenta reordenar dentro dela (`alvoDeReordenacaoNaRaia`, arrasto-de-raia.ts).
   * Soltar fora de qualquer raia, sobre uma recolhida, ou de volta exatamente
   * onde já estava (nas duas raias e na mesma) não gera chamada de IPC
   * nenhuma — o cartão volta para a posição que `layout` já tinha calculado
   * (a única fonte de posição — nunca a que o mouse deixou).
   */
  const handleNodeDragStop = useCallback<OnNodeDrag<NoDoCanvas>>(
    (_event, no) => {
      setRaiaAlvoDoArrasto(null);
      setLinhaDeInsercao(null);
      if (no.type !== "trilhaEtapa" || !layout || !trilha) return;
      const posicaoOriginal = layout.posicoes.get(no.id);
      if (!posicaoOriginal) return;
      const etapaArrastada = trilha.etapas.find((candidata) => candidata.id === no.id);
      if (!etapaArrastada) return;

      const voltarParaPosicaoOriginal = () =>
        setNodes((atuais) =>
          atuais.map((item) => (item.id === no.id ? { ...item, position: { x: posicaoOriginal.x, y: posicaoOriginal.y } } : item)),
        );

      const centroY = no.position.y + posicaoOriginal.height / 2;
      const laneAlvo = raiaAlvoNoY(centroY, layout.faixas);
      const laneAtual = laneEfetivaDaEtapa(etapaArrastada, trilha.raias);
      const laneParaEscrever = laneParaMover(laneAtual, laneAlvo);

      if (laneParaEscrever !== null) {
        void moverParaRaiaEVerificar(no.id, laneParaEscrever, posicaoOriginal);
        return;
      }

      if (laneAlvo === null) {
        // Soltou fora de qualquer raia (ou sobre uma recolhida): nem muda de
        // faixa, nem reordena — `laneParaMover` já filtrou este caso.
        voltarParaPosicaoOriginal();
        return;
      }

      // `laneAlvo === laneAtual`: continua na mesma raia — tenta reordenar.
      const irmaos = irmaosParaReordenar(trilha, layout, etapaArrastada);
      const alvo = alvoDeReordenacaoNaRaia(centroY, etapaArrastada.position, irmaos);
      if (alvo === null) {
        voltarParaPosicaoOriginal();
        return;
      }

      void reordenarEVerificar(no.id, alvo, posicaoOriginal);
    },
    [layout, trilha, moverParaRaiaEVerificar, reordenarEVerificar],
  );

  const handleNodeMouseEnter = useCallback((_evento: unknown, no: NoDoCanvas) => {
    if (no.type !== "trilhaEtapa") return;
    if (apagarCadeiaAgendado.current) clearTimeout(apagarCadeiaAgendado.current);
    apagarCadeiaAgendado.current = null;
    setEtapaSobOMouse(no.id);
  }, []);

  const handleNodeMouseLeave = useCallback(() => {
    if (apagarCadeiaAgendado.current) clearTimeout(apagarCadeiaAgendado.current);
    apagarCadeiaAgendado.current = setTimeout(() => setEtapaSobOMouse(null), ATRASO_PARA_APAGAR_CADEIA_MS);
  }, []);

  useEffect(() => () => {
    if (apagarCadeiaAgendado.current) clearTimeout(apagarCadeiaAgendado.current);
  }, []);

  // A etapa cuja cadeia está realçada: a sob o mouse, senão a selecionada
  // (é assim que teclado e clique também chegam aqui — selecionar um nó
  // com Enter/Espaço realça a cadeia dele sem precisar de mouse).
  const etapaSelecionada = useMemo(() => nodes.find((no) => no.type === "trilhaEtapa" && no.selected)?.id ?? null, [nodes]);
  const etapaEmFoco = etapaSobOMouse ?? etapaSelecionada;
  const cadeia = useMemo(() => (etapaEmFoco && trilha ? cadeiaDeDependencias(etapaEmFoco, trilha.flechas) : null), [etapaEmFoco, trilha]);

  // Os nós/arestas que o `<ReactFlow>` recebe são os de estado, mais a
  // classe da cadeia e/ou do destaque de arrasto — derivadas aqui, nunca
  // gravadas em `nodes` (que só muda por `onNodesChange`/`onNodeDrag`), para
  // nem o hover nem o arrasto dispararem um `setNodes` a cada quadro/cartão
  // atravessado.
  const nosComCadeia = useMemo<NoDoCanvas[]>(() => {
    const comClasses = nodes.map((no) => {
      // A raia sob o cartão em arrasto (item 3 do pedido: "deixe claro em
      // qual raia vai cair"). `raiaAlvoDoArrasto` só deixa de ser `null`
      // quando `handleNodeDrag` está de fato em voo sobre uma raia válida —
      // fora disso, todo `no.data.raia.laneValue` (sempre string) é diferente
      // de `null` e a comparação nunca bate.
      if (no.type === "trilhaRaia") {
        return no.data.raia.laneValue === raiaAlvoDoArrasto ? { ...no, className: "trilha-raia-no--alvo-do-arrasto" } : no;
      }
      if (no.type !== "trilhaEtapa" || !cadeia || !etapaEmFoco) return no;
      const papel =
        no.id === etapaEmFoco ? "trilha-no--foco" : cadeia.exige.has(no.id) ? "trilha-no--exige" : cadeia.desbloqueia.has(no.id) ? "trilha-no--desbloqueia" : null;
      return { ...no, className: papel ? `trilha-no--na-cadeia ${papel}` : "trilha-no--fora-da-cadeia" };
    });

    if (!linhaDeInsercao) return comClasses;
    // A linha de inserção não faz parte de `nodes` (estado que só muda por
    // `onNodesChange`/`onNodeDrag`) — é derivada aqui, igual ao destaque de
    // raia acima, para o arrasto não disparar um `setNodes` a cada quadro.
    const noDaLinha: NoDeLinhaDeInsercao = {
      id: ID_DA_LINHA_DE_INSERCAO,
      type: "trilhaLinhaDeInsercao",
      position: { x: linhaDeInsercao.x, y: linhaDeInsercao.y },
      selectable: false,
      focusable: false,
      draggable: false,
      deletable: false,
      zIndex: 2,
      data: { largura: linhaDeInsercao.largura },
    };
    return [...comClasses, noDaLinha];
  }, [nodes, cadeia, etapaEmFoco, raiaAlvoDoArrasto, linhaDeInsercao]);

  const arestasComCadeia = useMemo<FlechaDoCanvas[]>(() => {
    if (!cadeia || !etapaEmFoco) return edges;
    const naCadeia = new Set([etapaEmFoco, ...cadeia.exige, ...cadeia.desbloqueia]);
    return edges.map((aresta) => {
      const dentro = naCadeia.has(aresta.source) && naCadeia.has(aresta.target);
      return { ...aresta, className: `${aresta.className ?? ""} ${dentro ? "trilha-aresta--na-cadeia" : "trilha-aresta--fora-da-cadeia"}`.trim() };
    });
  }, [edges, cadeia, etapaEmFoco]);

  const handleConnect = useCallback<OnConnect>(
    (conexao) => {
      // `trilha` nunca é `null` aqui de fato (o `<ReactFlow>` só monta depois
      // do `if (!trilha) return null` abaixo), mas o tipo do `state` é
      // `Trilha | null` e não há como o `useCallback` estreitar isso —
      // guarda explícita em vez de `!`.
      if (!trilha) return;
      const argumentos = argumentosDeCriarFlecha(conexao, trilha.decisoes, trilha.flechas);
      if (!argumentos) return;

      if (argumentos.pathLabel === null) {
        // Etapa comum: sem rótulo, exatamente como antes (item 4 do pedido).
        void criarFlecha(argumentos.blockedId, argumentos.blockingId, null);
        return;
      }

      // Origem é uma decisão: abre o formulário em vez de criar direto — o
      // usuário decide o nome (item 3), a sugestão só preenche o campo.
      setConexaoPendente({ blockedId: argumentos.blockedId, blockingId: argumentos.blockingId, sugestao: argumentos.pathLabel });
    },
    [criarFlecha, trilha],
  );

  const handleDelete = useCallback<OnDelete<NoDoCanvas, FlechaDoCanvas>>(
    ({ edges: apagadas }) => {
      // Nós não são apagáveis por aqui (`deletable:false` em todos — o
      // contrato de IPC não tem "apagar etapa"); só arestas chegam.
      // Sequencial, não em paralelo: cada `apagarFlecha` relê a trilha
      // inteira, e disparar N releituras ao mesmo tempo correria o risco de
      // uma pisar na resposta da outra.
      void (async () => {
        for (const aresta of apagadas) {
          if (!aresta.data) continue;
          await apagarFlecha(aresta.data.blockedId, aresta.data.blockingId);
        }
      })();
    },
    [apagarFlecha],
  );

  if (!trilha) return null;

  const posicaoDaProxima = proximaEtapa && layout ? (layout.posicoes.get(proximaEtapa.id) ?? null) : null;
  const estadosPresentes = new Set<EstadoVisualDaEtapa>(trilha.etapas.map(estadoVisualDaEtapa));
  const temMarco = trilha.etapas.some((etapa) => ehMarco(etapa.id, trilha.flechas));
  const limiteDeArrasto: CoordinateExtent | undefined = layout
    ? [
        [-FOLGA_DE_ARRASTO, -FOLGA_DE_ARRASTO],
        [layout.largura + FOLGA_DE_ARRASTO, layout.altura + FOLGA_DE_ARRASTO],
      ]
    : undefined;

  return (
    <div className="trilha-secao">
      <BarraDaTrilha trilha={trilha} proximaEtapa={proximaEtapa} posicaoDaProxima={posicaoDaProxima} />

      <div ref={canvasRef} className={["trilha-canvas", cadeia ? "trilha-canvas--com-cadeia" : null].filter(Boolean).join(" ")}>
        {/* Mesma informação do desenho, em texto corrido — um leitor de tela
            que não interpreta bem um canvas SVG ainda enxerga título, estado
            e o que bloqueia cada etapa (item 6 do pedido). */}
        <ul className="sr-only">
          {trilha.etapas.map((etapa) => (
            <li key={etapa.id}>{descricaoParaLeitorDeTela(etapa, trilha.etapas, trilha.flechas, trilha.decisoes)}</li>
          ))}
        </ul>

        <ReactFlow<NoDoCanvas, FlechaDoCanvas>
          nodes={nosComCadeia}
          edges={arestasComCadeia}
          nodeTypes={TIPOS_DE_NO}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onDelete={handleDelete}
          onNodeMouseEnter={handleNodeMouseEnter}
          onNodeMouseLeave={handleNodeMouseLeave}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onInit={() => setCanvasPronto(true)}
          // Continua `false` como PADRÃO global — raia e fundo (sem
          // `draggable` próprio) herdam isto e continuam travados. O cartão
          // de etapa tem `draggable: true` explícito (`construirNos`, acima),
          // que sempre vence o global — ver o comentário lá.
          nodesDraggable={false}
          deleteKeyCode={["Backspace", "Delete"]}
          translateExtent={limiteDeArrasto}
          minZoom={0.4}
          maxZoom={1.6}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />

          <Panel position="bottom-left" className="trilha-rodape">
            <ControlesDoCanvas proximaEtapa={proximaEtapa && posicaoDaProxima ? { id: proximaEtapa.id, posicao: posicaoDaProxima } : null} />
            <LegendaDaTrilha estadosPresentes={estadosPresentes} temMarco={temMarco} />
          </Panel>

          {conexaoPendente ? (
            <Panel position="top-center">
              <FormularioDeRotuloDoCaminho
                sugestao={conexaoPendente.sugestao}
                onConfirmar={(rotulo) => {
                  void criarFlecha(conexaoPendente.blockedId, conexaoPendente.blockingId, rotulo);
                  setConexaoPendente(null);
                }}
                onCancelar={() => setConexaoPendente(null)}
              />
            </Panel>
          ) : null}

          {errorMessage ? (
            <Panel position="bottom-center">
              <p role="alert" className="rounded-sm border border-terracotta-ink bg-surface px-3 py-1.5 text-xs text-terracotta-ink shadow-hard-sm">
                {errorMessage}
              </p>
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
    </div>
  );
}
