import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
  type OnConnect,
  type OnDelete,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./mapa-mental.css";
import { EmptyState } from "../../components/EmptyState";
import { CriarCartaoDeOrigem } from "../cartoes/CriarCartaoDeOrigem";
import { CartaoNode } from "./CartaoNode";
import { useCriarCartaoDeNoStore } from "./criar-cartao-de-no-store";
import { useRecuperacaoStore } from "./recuperacao-store";
import { useMapaMentalStore, type ArestaDoMapa, type NoDoMapa } from "./store";
import { assinaturaDeTopologia, corarArestasPorRamo, encontrarRaizId } from "./topologia-do-mapa";

/**
 * Fora do componente de propósito: `nodeTypes` precisa de identidade estável
 * entre renders — recriar o objeto a cada render faz o `@xyflow/react` achar
 * que os tipos de nó mudaram e reconstruir o registro interno à toa.
 */
const TIPOS_DE_NO: NodeTypes = { cartaoMental: CartaoNode };

const COLUNAS_DA_GRADE_DE_CRIACAO = 6;
const PASSO_DA_GRADE_DE_CRIACAO_PX = 32;

interface FormularioDeNovoNoProps {
  onCriar: (label: string) => void;
}

/**
 * Só o campo de texto e o botão do canto superior — separado de `CanvasDoMapa`
 * para esse não crescer além do que orquestra o `<ReactFlow>` em si. Dono do
 * próprio rascunho: limpa o campo sozinho depois de `onCriar`.
 */
function FormularioDeNovoNo({ onCriar }: FormularioDeNovoNoProps) {
  const [texto, setTexto] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = texto.trim();
    if (!label) return;
    onCriar(label);
    setTexto("");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1.5 shadow-hard-sm"
    >
      <label htmlFor="mapa-mental-texto-do-no" className="sr-only">
        Texto do novo cartão
      </label>
      <input
        id="mapa-mental-texto-do-no"
        type="text"
        value={texto}
        onChange={(event) => setTexto(event.currentTarget.value)}
        placeholder="Texto do cartão"
        className="w-40 rounded-sm border border-border bg-paper px-2 py-1 text-sm text-ink outline-none"
      />
      <button
        type="submit"
        disabled={texto.trim().length === 0}
        className="shrink-0 rounded-sm bg-emerald px-2 py-1 text-xs font-medium text-on-emerald transition-transform duration-150 ease-out active:scale-97 disabled:opacity-50"
      >
        + Cartão
      </button>
    </form>
  );
}

/**
 * O canvas em si. Vive dentro de `ReactFlowProvider` (montado por
 * `ConteudoDeMapaMental`, que também decide se há mapa para mostrar) porque
 * `useReactFlow` — usado aqui para converter clique de tela em posição do
 * canvas — só existe dentro do provider.
 */
function CanvasDoMapa() {
  const statusGrafo = useMapaMentalStore((state) => state.statusGrafo);
  const errorMessage = useMapaMentalStore((state) => state.errorMessage);
  const nos = useMapaMentalStore((state) => state.nos);
  const arestas = useMapaMentalStore((state) => state.arestas);
  const aoMudarNos = useMapaMentalStore((state) => state.aoMudarNos);
  const aoMudarArestas = useMapaMentalStore((state) => state.aoMudarArestas);
  const criarNo = useMapaMentalStore((state) => state.criarNo);
  const criarFilho = useMapaMentalStore((state) => state.criarFilho);
  const criarIrmao = useMapaMentalStore((state) => state.criarIrmao);
  const confirmarArrasto = useMapaMentalStore((state) => state.confirmarArrasto);
  const conectar = useMapaMentalStore((state) => state.conectar);
  const apagarElementos = useMapaMentalStore((state) => state.apagarElementos);
  const organizarLayoutRadial = useMapaMentalStore((state) => state.organizarLayoutRadial);

  // Item 1 do briefing: modo de recuperação. Store separada — ver o
  // comentário de topo de `recuperacao-store.ts` — porque nada aqui é dado
  // do mapa; é só o estado de UMA passada de revisão na tela.
  const mapaAtivoId = useMapaMentalStore((state) => state.mapaAtivoId);
  const modoRecuperacaoAtivo = useRecuperacaoStore((state) => state.ativo);
  const focoId = useRecuperacaoStore((state) => state.focoId);
  const iniciarRecuperacao = useRecuperacaoStore((state) => state.iniciar);
  const sairDaRecuperacao = useRecuperacaoStore((state) => state.sair);
  const revelarNoRecuperacao = useRecuperacaoStore((state) => state.revelar);
  const revelarTodosNaRecuperacao = useRecuperacaoStore((state) => state.revelarTodos);
  const focarNaRecuperacao = useRecuperacaoStore((state) => state.focar);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  // `assinaturaDeTopologia` é a dependência REAL destes dois `useMemo` — não
  // `nos` diretamente. `nos` muda de referência a cada quadro de arrasto (o
  // `@xyflow/react` recria o array a cada `NodeChange` de posição), mas nem
  // a raiz nem a cor de um ramo dependem de POSIÇÃO — só de topologia (quem é
  // pai de quem) e de `data.color`. Comparar a assinatura (uma string, por
  // conteúdo) em vez do array (por referência) é o que evita recalcular os
  // dois a 60fps durante um arrasto — ver o "porquê" completo em
  // `topologia-do-mapa.ts`. `nos`/`arestas` continuam sendo lidos DENTRO do
  // callback (via closure): quando a assinatura não muda, o `useMemo` nem
  // roda o callback, então não há risco de ler um `nos` desatualizado — só
  // roda de novo quando a assinatura (ou `arestas`) de fato mudou, e aí `nos`
  // já é o do render atual.
  const assinaturaTopologia = useMemo(() => assinaturaDeTopologia(nos), [nos]);

  // O raiz do mapa: nenhuma aresta chega nele (mesmo cálculo de `souRaiz` em
  // `CartaoNode.tsx`, refeito aqui só para saber ONDE pôr o cursor de
  // navegação ao entrar no modo — o próprio destaque "sou o raiz, sempre
  // visível" mora no nó, não aqui). Com mais de um nó sem aresta de entrada
  // (órfãos do "+ Cartão"), o primeiro da lista vira o ponto de partida; não
  // muda o que cada nó individualmente mostra.
  const raizId = useMemo(() => encontrarRaizId(nos, arestas), [assinaturaTopologia, arestas]);

  // Trocar de mapa com o modo ligado deixaria `revelados` apontando para os
  // nós do mapa ANTERIOR — sai do modo sempre que o mapa ativo muda (troca
  // pela barra lateral, sem passar pelo estado vazio que desmontaria este
  // componente) e também ao desmontar (fechar o mapa). `sairDaRecuperacao`
  // é idempotente (não escreve nada se já estava fora), então rodar aqui
  // sem checar o estado atual é seguro.
  useEffect(() => {
    sairDaRecuperacao();
    return () => sairDaRecuperacao();
  }, [mapaAtivoId, sairDaRecuperacao]);

  // Cada aresta ganha a cor do RAMO do seu nó-filho (o `target`, sempre que
  // `criarFilhoDe`/`store.ts` é quem criou a ligação) — item 5 do briefing.
  // Derivado a cada render, não guardado no store: é puramente uma função de
  // `nos`/`arestas`, então guardá-lo separado só criaria mais um jeito de os
  // dois ficarem dessincronizados. Depende de `assinaturaTopologia`, não de
  // `nos` — ver o comentário dela, logo acima.
  const arestasComCor = useMemo(
    () => corarArestasPorRamo(nos, arestas),
    [assinaturaTopologia, arestas],
  );

  // PONTO 2 do briefing: Tab cria filho, Enter cria irmão — o gesto de
  // digitação rápida que todo app de mapa mental tem. Só reage com
  // EXATAMENTE um nó selecionado (nada selecionado ou seleção múltipla não
  // tem "o nó" pra partir) e fora de um campo de texto — sem o guard de tag,
  // Tab/Enter dentro do `<input>` de edição de `CartaoNode` criaria um nó
  // no meio da digitação, em vez de mover o foco / confirmar o texto.
  // `CartaoNode` também para a propagação desses mesmos eventos por conta
  // própria (defesa em profundidade, ver o comentário lá).
  const handleKeyDownDoCanvas = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // `instanceof Element`, não `as HTMLElement`: `event.target` é
      // `EventTarget` (sem `.tagName`), e o cast assumiria um HTMLElement
      // quando o alvo real pode ser um `<path>`/`<g>` SVG (as arestas do
      // canvas) — que é `SVGElement`, não `HTMLElement`, mas tem `.tagName`
      // do mesmo jeito (é `Element`, a interface-mãe dos dois). `instanceof`
      // resolve com um type guard de verdade, sem afirmar nada de mais.
      const alvo = event.target;
      if (alvo instanceof Element && (alvo.tagName === "INPUT" || alvo.tagName === "TEXTAREA")) return;

      // Teclado do modo de recuperação (briefing, item 1: "por teclado
      // também: percorrer os nós e revelar sem mouse") — ramo à parte,
      // ANTES do Tab/Enter normais: dentro do modo essas duas teclas não
      // criam filho/irmão (seria escrita, e o modo é leitura), viram
      // navegação/revelação. Setas andam pela ordem de `nos` (a mesma lista
      // que já decide a grade do "+ Cartão" — ordem estável o bastante para
      // um cursor previsível), Enter/Espaço revela o nó sob o cursor, Esc
      // sai do modo (sem alterar nada — mesma `sairDaRecuperacao` do botão).
      if (modoRecuperacaoAtivo) {
        if (nos.length === 0) return;
        const indiceAtual = Math.max(0, nos.findIndex((no) => no.id === focoId));
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          focarNaRecuperacao(nos[(indiceAtual + 1) % nos.length].id);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          focarNaRecuperacao(nos[(indiceAtual - 1 + nos.length) % nos.length].id);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (focoId) revelarNoRecuperacao(focoId);
        } else if (event.key === "Escape") {
          event.preventDefault();
          sairDaRecuperacao();
        }
        return;
      }

      if (event.key !== "Tab" && event.key !== "Enter") return;
      const selecionados = nos.filter((no) => no.selected);
      if (selecionados.length !== 1) return;
      event.preventDefault();
      const [no] = selecionados;
      if (event.key === "Tab") {
        void criarFilho(no.id);
      } else {
        void criarIrmao(no.id);
      }
    },
    [
      nos,
      criarFilho,
      criarIrmao,
      modoRecuperacaoAtivo,
      focoId,
      focarNaRecuperacao,
      revelarNoRecuperacao,
      sairDaRecuperacao,
    ],
  );

  // PONTO 1 do briefing: persistência em lote. `onNodeDrag` (a cada quadro do
  // arrasto) não chama nada daqui — só `aoMudarNos`, puramente local, roda a
  // 60fps. É `onNodeDragStop`, que o `@xyflow/react` dispara UMA vez por
  // gesto (já com a lista final de todos os nós movidos, cobrindo arrasto de
  // seleção múltipla), que vira a única chamada de IPC do gesto inteiro.
  const handleNodeDragStop = useCallback<OnNodeDrag<NoDoMapa>>(
    (_evento, _no, nosMovidos) => {
      void confirmarArrasto(nosMovidos);
    },
    [confirmarArrasto],
  );

  const handleConnect = useCallback<OnConnect>(
    (conexao) => {
      void conectar(conexao);
    },
    [conectar],
  );

  // Mesma lógica de lote para apagar: `onDelete` (não `onNodesDelete`
  // separado de `onEdgesDelete`) chega uma vez por tecla Delete/Backspace já
  // com nós E arestas juntos — inclusive as arestas que caem junto com um nó
  // apagado — então uma tecla apertada vira uma chamada só, não duas.
  const handleDelete = useCallback<OnDelete<NoDoMapa, ArestaDoMapa>>(
    ({ nodes, edges }) => {
      void apagarElementos(nodes, edges);
    },
    [apagarElementos],
  );

  function criarCartaoNoCentro(label: string) {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const rect = wrapper.getBoundingClientRect();
    const centro = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    // Desempata cliques repetidos em "+ Cartão" numa grade em vez de empilhar
    // tudo exatamente no centro — não precisa ser bonito, só visível.
    const indice = nos.length;
    const posicao = {
      x: centro.x + (indice % COLUNAS_DA_GRADE_DE_CRIACAO) * PASSO_DA_GRADE_DE_CRIACAO_PX,
      y: centro.y + Math.floor(indice / COLUNAS_DA_GRADE_DE_CRIACAO) * PASSO_DA_GRADE_DE_CRIACAO_PX,
    };
    void criarNo(label, posicao);
  }

  if (statusGrafo === "error") {
    return (
      <p role="alert" className="px-6 py-4 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar este mapa mental."}
      </p>
    );
  }

  if (statusGrafo === "loading" || statusGrafo === "idle") {
    return <p className="px-6 py-4 text-sm text-ink-muted">Carregando mapa mental…</p>;
  }

  return (
    <div
      ref={wrapperRef}
      className="mapa-mental-canvas relative h-full w-full"
      onKeyDown={handleKeyDownDoCanvas}
    >
      <ReactFlow<NoDoMapa, ArestaDoMapa>
        nodes={nos}
        edges={arestasComCor}
        onNodesChange={aoMudarNos}
        onEdgesChange={aoMudarArestas}
        onNodeDragStop={handleNodeDragStop}
        onConnect={handleConnect}
        onDelete={handleDelete}
        nodeTypes={TIPOS_DE_NO}
        // "loose": handles todos "source" (ver `CartaoNode.tsx`) podem se
        // ligar entre si — não existe fonte/destino num mapa mental.
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={modoRecuperacaoAtivo ? [] : ["Backspace", "Delete"]}
        // As três linhas abaixo são a garantia, no nível do próprio
        // `<ReactFlow>`, de que o modo de recuperação é LEITURA (briefing,
        // item 1): arrastar não dispara `onNodeDragStop` (que chama
        // `confirmarArrasto`, uma escrita), ligar não dispara `onConnect`
        // (`conectar`, outra escrita), e a seleção nativa da lib fica
        // desligada porque o clique, dentro do modo, serve para REVELAR
        // (ver `CartaoNode.tsx`), não para selecionar um nó para editar.
        nodesDraggable={!modoRecuperacaoAtivo}
        nodesConnectable={!modoRecuperacaoAtivo}
        elementsSelectable={!modoRecuperacaoAtivo}
        // Desligada por padrão na lib: sem isto, todo nó fora da tela
        // continua montado no DOM mesmo depois de o usuário dar zoom numa
        // parte do mapa (o `fitView` acima só se aplica ao abrir — depois
        // disso o usuário pode navegar livremente). Medido
        // (`desempenho.test.ts`): com zoom 2x num mapa de 500 nós, isto
        // corta de 500 para ~10 os cartões realmente montados. Nenhum outro
        // código deste diretório depende de um nó fora da tela continuar no
        // DOM (a navegação do modo de recuperação, por exemplo, percorre o
        // array `nos` do store, não elementos do DOM).
        onlyRenderVisibleElements
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls />
        {!modoRecuperacaoAtivo && (
          <Panel position="top-left">
            <FormularioDeNovoNo onCriar={criarCartaoNoCentro} />
          </Panel>
        )}
        <Panel position="top-right">
          {modoRecuperacaoAtivo ? (
            <div className="flex items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1.5 shadow-hard-sm">
              <span className="text-xs text-ink-muted">Modo de recuperação</span>
              <button
                type="button"
                onClick={() => revelarTodosNaRecuperacao(nos.map((no) => no.id))}
                className="shrink-0 rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-ink transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
              >
                Revelar tudo
              </button>
              <button
                type="button"
                onClick={() => sairDaRecuperacao()}
                className="shrink-0 rounded-sm bg-emerald px-2 py-1 text-xs font-medium text-on-emerald transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
              >
                Sair
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void organizarLayoutRadial()}
                className="rounded-sm border border-border bg-surface px-2 py-1.5 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
              >
                Organizar
              </button>
              <button
                type="button"
                onClick={() => iniciarRecuperacao(raizId)}
                disabled={nos.length === 0}
                className="rounded-sm border border-border bg-surface px-2 py-1.5 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 disabled:opacity-50 motion-reduce:transition-none"
              >
                Modo de recuperação
              </button>
            </div>
          )}
        </Panel>
        {modoRecuperacaoAtivo && (
          <Panel position="bottom-center">
            <p role="status" className="rounded-sm border border-border bg-surface px-3 py-1.5 text-xs text-ink-muted shadow-hard-sm">
              Tente lembrar antes de clicar. Setas para navegar, Enter/Espaço para revelar, Esc para sair.
            </p>
          </Panel>
        )}
        {// PONTO do "catch vazio/erro sem destino" do briefing: antes,
        // `errorMessage` era escrito pela store em toda falha de mutação
        // (criar/mover/ligar/apagar nó) mas nenhuma tela lia esse campo fora
        // do caminho de CARREGAR o grafo (`statusGrafo === "error"`) — a
        // falha ficava muda. Isto mostra qualquer erro de mutação sem
        // esconder o canvas por trás dele.
        errorMessage && (
          <Panel position="top-center">
            <p
              role="alert"
              className="rounded-sm border border-terracotta-ink bg-surface px-3 py-1.5 text-xs text-terracotta-ink shadow-hard-sm"
            >
              {errorMessage}
            </p>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

/**
 * O formulário de "Criar cartão" (`CartaoNode`'s `NodeToolbar`) — montado uma
 * vez aqui, fora do canvas, porque `criar-cartao-de-no-store.ts` é a única
 * coisa que precisa atravessar de um nó específico (dentro do `<ReactFlow>`)
 * até este nível. Só `rotulo` viaja: um nó de mapa mental nunca tem
 * `blocoOrigemId`, então este cartão nunca ganha link de volta — ver o
 * comentário da store.
 */
function CriarCartaoDoNoOverlay() {
  const aberto = useCriarCartaoDeNoStore((state) => state.aberto);
  const rotulo = useCriarCartaoDeNoStore((state) => state.rotulo);
  const fechar = useCriarCartaoDeNoStore((state) => state.fechar);

  return <CriarCartaoDeOrigem isOpen={aberto} origem={{ trecho: rotulo }} onClose={fechar} />;
}

/**
 * A área principal da seção Mapa mental — implementa `ImplementacaoDaSecao.Conteudo`
 * (ver `features/navegacao/contrato.ts`). Sem props: qual mapa está ativo mora em
 * `useMapaMentalStore`, e é assim que `PainelDeMapaMental` (a lista/CRUD de mapas) e
 * este componente conversam sem passar pela casca — mesmo padrão de `secao-notas.tsx`.
 */
export function ConteudoDeMapaMental() {
  const mapaAtivoId = useMapaMentalStore((state) => state.mapaAtivoId);

  if (mapaAtivoId === null) {
    return (
      <EmptyState
        title="Nenhum mapa mental aberto"
        description="Escolha ou crie um mapa na barra lateral para começar a ligar ideias."
      />
    );
  }

  return (
    <ReactFlowProvider>
      <CanvasDoMapa />
      <CriarCartaoDoNoOverlay />
    </ReactFlowProvider>
  );
}
