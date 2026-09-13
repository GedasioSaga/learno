import { create } from "zustand";
import { addEdge, applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import type { Connection, Edge, EdgeChange, Node, NodeChange } from "@xyflow/react";
import {
  AppError,
  applyMindmapChanges,
  createMindmap,
  deleteMindmap,
  getMindmap,
  listMindmaps,
  renameMindmap,
  type MindmapChange,
  type MindmapGraph,
  type MindmapRow,
} from "../../lib/ipc";
import { proximaCorDeRamo } from "./cores-de-ramo";
import { layoutRadial } from "./layout-radial";

/**
 * O que um cartão do mapa mental carrega. `shape` e `icon` já existem nas
 * colunas do backend (`mindmap_nodes`), mas esta rodada não tem UI para
 * defini-los, então o canvas nem os lê. `color` já tem UI: é a cor do ramo
 * (id da paleta em `cores-de-ramo.ts`, ex. "amber"), herdada do pai ou
 * atribuída na criação — `null`/ausente é a raiz ou um nó órfão do
 * "+ Cartão", sem ramo. Opcional (`?`) pra não quebrar quem já criava
 * `NoDoMapa` sem pensar em cor (ex. `criarNo`, que continua sem ramo).
 *
 * `type`, não `interface`: `Node<NodeData extends Record<string, unknown>>`
 * exige essa constraint, e só um alias de objeto ganha a assinatura de
 * índice implícita que satisfaz `Record<string, unknown>` — uma `interface`
 * com o mesmo formato falha o type-check (TS2344) mesmo sendo, na prática,
 * a mesma forma.
 */
export type DadosDoNo = {
  label: string;
  color?: string | null;
  /**
   * Nome do arquivo dentro de `media/` (mesma coluna `image` de 0032, o
   * mesmo `content.src` do editor de blocos — ver `media-storage.ts`), nunca
   * uma URL exibível: `CartaoNode.tsx` resolve isto pra URL sozinho via
   * `resolveMediaSrc`, do mesmo jeito que `FileThumbnail` resolve `FileRef.src`
   * em `FilesCell.tsx`. `null`/ausente é o normal — a maioria dos cartões
   * não tem imagem.
   */
  image?: string | null;
};

/** Um nó do canvas, sempre do tipo "cartaoMental" — ver `CartaoNode.tsx`. */
export type NoDoMapa = Node<DadosDoNo, "cartaoMental">;

export type ArestaDoMapa = Edge;

/** Texto do cartão recém-criado por Tab/Enter (ou o raiz de um mapa novo) —
 *  sempre entra direto em edição (`pendingEditNoId`), então este texto some
 *  na hora que o usuário digita; existe só pra nunca haver um cartão em
 *  branco de verdade entre o clique/tecla e o primeiro caractere digitado. */
const ROTULO_DE_NO_NOVO = "Novo tópico";

/** Deslocamento (px) do filho/irmão novo em relação ao pai — só a posição
 *  INICIAL, antes de o usuário arrastar ou clicar "Organizar"; não precisa
 *  ser perfeito, só visível e não empilhado exatamente em cima do pai. */
const DESLOCAMENTO_X_FILHO = 220;
const DESLOCAMENTO_Y_FILHO = 90;

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface MapaMentalState {
  statusLista: LoadStatus;
  mapas: MindmapRow[];
  mapaAtivoId: string | null;
  statusGrafo: LoadStatus;
  errorMessage: string | null;
  nos: NoDoMapa[];
  arestas: ArestaDoMapa[];
  /**
   * Id do mapa que acabou de nascer por "Novo mapa" e ainda precisa entrar em
   * modo de edição de nome assim que sua linha for renderizada — mesmo papel
   * de `pendingFocusId` em `features/pages/store.ts` (FUN-002), só que para
   * mapas em vez de páginas.
   */
  pendingRenameId: string | null;
  /**
   * Id do NÓ (dentro do canvas) que acabou de nascer — o raiz de um mapa
   * novo, ou o filho/irmão criado por Tab/Enter — e ainda precisa entrar em
   * modo de edição de texto assim que `CartaoNode` renderizar. Mesmo papel de
   * `pendingRenameId` acima, só que para um cartão em vez de uma linha da
   * lista — ver `CartaoNode.tsx`.
   */
  pendingEditNoId: string | null;

  carregarMapas: () => Promise<void>;
  selecionarMapa: (id: string) => Promise<void>;
  criarMapa: (nome: string) => Promise<MindmapRow>;
  consumePendingRename: (id: string) => void;
  consumePendingEditNo: (id: string) => void;
  renomearMapa: (id: string, nome: string) => Promise<void>;
  apagarMapa: (id: string) => Promise<void>;

  /** Aplicação puramente local (arrastar em andamento, seleção) — sem IPC. */
  aoMudarNos: (changes: NodeChange<NoDoMapa>[]) => void;
  aoMudarArestas: (changes: EdgeChange<ArestaDoMapa>[]) => void;
  /** Cartão solto, sem ramo — o "+ Cartão" da barra do canvas. */
  criarNo: (label: string, posicao: { x: number; y: number }) => Promise<void>;
  /** Tab no nó selecionado: cria um filho, ligado por aresta, herdando (ou
   *  abrindo) a cor do ramo do pai — ver `cores-de-ramo.ts`. */
  criarFilho: (idDoPai: string) => Promise<void>;
  /** Enter no nó selecionado: cria um irmão (mesmo pai), na mesma cor de
   *  ramo. Sem pai (o nó é a raiz, ou está órfão) se comporta como Tab. */
  criarIrmao: (idDoNo: string) => Promise<void>;
  /** Renomeia o texto de um nó já existente (edição in-place no cartão). */
  renomearNo: (id: string, label: string) => Promise<void>;
  /**
   * Troca a imagem de um nó, ou remove com `image: null` — reusa
   * `media-storage.ts` (o mesmo armazenamento do editor de blocos), então
   * `image` aqui é sempre o "nome do arquivo em `media/`" que
   * `storeMediaFile` devolveu, nunca uma URL. `null` precisa mesmo ser
   * MANDADO (não omitido) para o backend distinguir "sem mudança" de
   * "remover" — ver o comentário de `MindmapNodePatch.image` em `lib/ipc.ts`.
   */
  definirImagemDoNo: (id: string, image: string | null) => Promise<void>;
  /**
   * Persistência em lote de um arrasto: UMA chamada por gesto concluído,
   * cobrindo todos os nós movidos juntos (seleção múltipla), nunca uma por
   * quadro. Chamar a partir de `onNodeDragStop`, nunca de `onNodeDrag`.
   */
  confirmarArrasto: (nosMovidos: NoDoMapa[]) => Promise<void>;
  conectar: (conexao: Connection) => Promise<void>;
  /** Também em lote: uma tecla Delete pode apagar vários nós/arestas de uma vez — uma chamada só. */
  apagarElementos: (nosApagados: NoDoMapa[], arestasApagadas: ArestaDoMapa[]) => Promise<void>;
  /** Recalcula o layout radial da árvore inteira e persiste as novas
   *  posições numa chamada só (mesmo padrão de `confirmarArrasto`). */
  organizarLayoutRadial: () => Promise<void>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * Lê `sourceHandle`/`targetHandle` de dentro do JSON livre de
 * `MindmapEdgeRow.style` — é aqui, não numa coluna própria, que a aresta
 * lembra de QUAL LADO de cada cartão ela saiu/chegou (`conectar`, abaixo,
 * grava os dois na criação). Sem isto, toda aresta recarregada do banco
 * perderia essa informação e o `@xyflow/react` voltaria a desenhá-la a
 * partir do primeiro handle de cada nó — exatamente o defeito A do
 * relatório, só que reaparecendo depois de um reload em vez de na hora de
 * ligar. Tolerante a qualquer forma de `style` (JSON livre, `{}` por
 * padrão, ou uma aresta antiga de antes desta mudança): campo ausente ou do
 * tipo errado vira `undefined`, nunca lança.
 */
function handlesDoEstilo(style: unknown): { sourceHandle?: string; targetHandle?: string } {
  if (typeof style !== "object" || style === null) return {};
  // Seguro: acabamos de checar que é um objeto não-nulo acima — isto só
  // amplia o tipo pra poder sondar duas chaves opcionais sem afirmar que
  // elas existem.
  const candidato = style as Record<string, unknown>;
  return {
    sourceHandle: typeof candidato.sourceHandle === "string" ? candidato.sourceHandle : undefined,
    targetHandle: typeof candidato.targetHandle === "string" ? candidato.targetHandle : undefined,
  };
}

function converterGrafo(grafo: MindmapGraph): { nos: NoDoMapa[]; arestas: ArestaDoMapa[] } {
  const nos: NoDoMapa[] = grafo.nodes.map((linha) => ({
    id: linha.id,
    type: "cartaoMental",
    position: { x: linha.positionX, y: linha.positionY },
    data: { label: linha.label, color: linha.color, image: linha.image },
  }));
  const arestas: ArestaDoMapa[] = grafo.edges.map((linha) => ({
    id: linha.id,
    source: linha.sourceNodeId,
    target: linha.targetNodeId,
    label: linha.label ?? undefined,
    ...handlesDoEstilo(linha.style),
  }));
  return { nos, arestas };
}

export const useMapaMentalStore = create<MapaMentalState>((set, get) => {
  /**
   * O funil único de toda escrita no grafo: cria/move/liga/apaga passam por
   * aqui. Em caso de sucesso, o grafo local é substituído pelo que o backend
   * devolveu — a mesma resposta de `applyMindmapChanges` já traz o mapa
   * inteiro atualizado, então isto também é o que confirma (ou corrige) a
   * edição otimista que o chamador aplicou antes de entrar aqui. Em caso de
   * falha, em vez de tentar desfazer mudança por mudança, recarrega o grafo
   * de verdade do backend — mais simples e sempre correto, ao custo de uma
   * segunda chamada só no caminho de erro (mesmo princípio de
   * `PageTreeStore.trash`/`duplicate`, que recarrega em vez de corrigir à mão).
   */
  async function aplicarMudancas(mindmapId: string, changes: MindmapChange[]): Promise<void> {
    if (changes.length === 0) return;
    try {
      const grafo = await applyMindmapChanges(mindmapId, changes);
      // O usuário pode ter trocado de mapa enquanto isto estava em voo — não
      // deixa a resposta de um mapa antigo pisar no que está na tela agora.
      if (get().mapaAtivoId !== mindmapId) return;
      set({ ...converterGrafo(grafo), errorMessage: null });
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível salvar a mudança no mapa mental.") });
      if (get().mapaAtivoId !== mindmapId) return;
      try {
        const grafoAtual = await getMindmap(mindmapId);
        if (get().mapaAtivoId === mindmapId) {
          set(converterGrafo(grafoAtual));
        }
      } catch {
        // Sem rede/banco para nem isto, a edição otimista fica na tela como
        // está; o `errorMessage` já contado acima é o aviso que existe.
      }
    }
  }

  /**
   * Cria um nó — raiz de mapa novo, ou filho/irmão via Tab/Enter — e
   * opcionalmente já o liga a um pai por aresta, tudo numa ÚNICA chamada de
   * `aplicarMudancas` (mesmo princípio de lote de `confirmarArrasto`). O nó
   * novo nasce selecionado (desmarca os outros) e marcado em
   * `pendingEditNoId`, pra `CartaoNode` entrar em edição sozinho — é o que
   * garante "abre com o nó raiz pronto pra ser renomeado" (item 1 do
   * briefing) e o fluxo de digitação rápida de Tab/Enter (item 2).
   *
   * A resposta do backend, aplicada por `aplicarMudancas`, substitui
   * `nos`/`arestas` inteiros e não carrega `selected` (não é coluna do
   * banco) — por isso a seleção é reaplicada depois do `await`, sobre o
   * estado que efetivamente ficou de pé (podendo já ser o de recuperação de
   * erro, daí o guard de `mapaAtivoId`).
   */
  async function criarNoDeRamo(
    mindmapId: string,
    opts: { label: string; posicao: { x: number; y: number }; color: string | null; idDoPai?: string },
  ): Promise<string> {
    const { label, posicao, color, idDoPai } = opts;
    const id = crypto.randomUUID();
    const novaArestaId = idDoPai ? crypto.randomUUID() : null;
    const novoNo: NoDoMapa = { id, type: "cartaoMental", position: posicao, selected: true, data: { label, color } };

    set((state) => ({
      nos: [...state.nos.map((no) => ({ ...no, selected: false })), novoNo],
      arestas:
        idDoPai && novaArestaId
          ? [...state.arestas, { id: novaArestaId, source: idDoPai, target: id }]
          : state.arestas,
      pendingEditNoId: id,
    }));

    const changes: MindmapChange[] = [
      { kind: "createNode", node: { id, label, positionX: posicao.x, positionY: posicao.y, color } },
    ];
    if (idDoPai && novaArestaId) {
      changes.push({ kind: "createEdge", edge: { id: novaArestaId, sourceNodeId: idDoPai, targetNodeId: id } });
    }
    await aplicarMudancas(mindmapId, changes);

    if (get().mapaAtivoId === mindmapId) {
      set((state) => ({ nos: state.nos.map((no) => ({ ...no, selected: no.id === id })) }));
    }
    return id;
  }

  /**
   * Núcleo compartilhado de `criarFilho`/`criarIrmao`: os dois terminam
   * criando "mais um filho de `idDoPai`" — só diferem em COMO chegam nesse
   * `idDoPai` (o próprio nó selecionado, ou o pai do nó selecionado) e,
   * quando é `criarIrmao` chamando, em qual cor usar.
   *
   * `corPreferida`, quando vem preenchida, VENCE o cálculo normal
   * (herdar do pai / abrir cor nova pelo número de filhos). É o caso de
   * `criarIrmao`: o "pai" que este helper recebe é o AVÔ do nó em edição
   * (o pai do nó selecionado), e ele pode não ter cor própria (é a raiz) —
   * sem `corPreferida`, cada Enter abriria uma cor NOVA por causa da conta
   * "filho de um nó sem cor", em vez de continuar o MESMO ramo do irmão que
   * originou o Enter.
   */
  async function criarFilhoDe(mindmapId: string, idDoPai: string, corPreferida?: string | null): Promise<void> {
    const pai = get().nos.find((no) => no.id === idDoPai);
    if (!pai) return;
    const numFilhosAntes = get().arestas.filter((aresta) => aresta.source === idDoPai).length;
    const color = corPreferida ?? proximaCorDeRamo(pai.data.color, numFilhosAntes);
    const posicao = {
      x: pai.position.x + DESLOCAMENTO_X_FILHO,
      y: pai.position.y + numFilhosAntes * DESLOCAMENTO_Y_FILHO,
    };
    await criarNoDeRamo(mindmapId, { label: ROTULO_DE_NO_NOVO, posicao, color, idDoPai });
  }

  return {
    statusLista: "idle",
    mapas: [],
    mapaAtivoId: null,
    statusGrafo: "idle",
    errorMessage: null,
    nos: [],
    arestas: [],
    pendingRenameId: null,
    pendingEditNoId: null,

    carregarMapas: async () => {
      set({ statusLista: "loading", errorMessage: null });
      try {
        const mapas = await listMindmaps();
        set({ statusLista: "ready", mapas });
      } catch (error) {
        set({ statusLista: "error", errorMessage: messageFor(error, "Não foi possível carregar os mapas mentais.") });
      }
    },

    selecionarMapa: async (id) => {
      set({ mapaAtivoId: id, statusGrafo: "loading", errorMessage: null, nos: [], arestas: [] });
      try {
        const grafo = await getMindmap(id);
        if (get().mapaAtivoId !== id) return;
        set({ statusGrafo: "ready", ...converterGrafo(grafo) });
      } catch (error) {
        if (get().mapaAtivoId !== id) return;
        set({ statusGrafo: "error", errorMessage: messageFor(error, "Não foi possível carregar este mapa mental.") });
      }
    },

    criarMapa: async (nome) => {
      try {
        const mapa = await createMindmap(nome);
        set((state) => ({ mapas: [...state.mapas, mapa], pendingRenameId: mapa.id }));
        await get().selecionarMapa(mapa.id);
        // Item 1 do briefing: "mapa novo em branco absoluto é um beco sem
        // saída" — sem isto, Tab/Enter não têm em cima de qual nó agir (as
        // duas ações partem de um nó JÁ selecionado) e "+ Cartão" cria um
        // cartão solto, sem ramo. O raiz nasce aqui, já selecionado e em
        // edição (`criarNoDeRamo`), pronto pra digitar o assunto do mapa.
        // Falha aqui não derruba `criarMapa` (o mapa em si já existe): o
        // `aplicarMudancas` dentro de `criarNoDeRamo` já cuida do próprio
        // erro e o deixa em `errorMessage`, com destino na tela — ver
        // `PainelDeMapaMental`/`ConteudoDeMapaMental`.
        await criarNoDeRamo(mapa.id, { label: ROTULO_DE_NO_NOVO, posicao: { x: 0, y: 0 }, color: null });
        return mapa;
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível criar o mapa mental.") });
        throw error;
      }
    },

    consumePendingRename: (id) => {
      if (get().pendingRenameId === id) set({ pendingRenameId: null });
    },

    consumePendingEditNo: (id) => {
      if (get().pendingEditNoId === id) set({ pendingEditNoId: null });
    },

    renomearMapa: async (id, nome) => {
      try {
        const mapa = await renameMindmap(id, nome);
        set((state) => ({ mapas: state.mapas.map((item) => (item.id === id ? mapa : item)) }));
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível renomear o mapa mental.") });
        throw error;
      }
    },

    apagarMapa: async (id) => {
      try {
        await deleteMindmap(id);
        set((state) => ({
          mapas: state.mapas.filter((item) => item.id !== id),
          ...(state.mapaAtivoId === id
            ? { mapaAtivoId: null, statusGrafo: "idle" as const, nos: [], arestas: [] }
            : {}),
        }));
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível apagar o mapa mental.") });
        throw error;
      }
    },

    aoMudarNos: (changes) => {
      set((state) => ({ nos: applyNodeChanges(changes, state.nos) }));
    },

    aoMudarArestas: (changes) => {
      set((state) => ({ arestas: applyEdgeChanges(changes, state.arestas) }));
    },

    criarNo: async (label, posicao) => {
      const mindmapId = get().mapaAtivoId;
      if (!mindmapId) return;
      const id = crypto.randomUUID();
      const novo: NoDoMapa = { id, type: "cartaoMental", position: posicao, data: { label } };
      set((state) => ({ nos: [...state.nos, novo] }));
      await aplicarMudancas(mindmapId, [
        { kind: "createNode", node: { id, label, positionX: posicao.x, positionY: posicao.y } },
      ]);
    },

    criarFilho: async (idDoPai) => {
      const mindmapId = get().mapaAtivoId;
      if (!mindmapId) return;
      await criarFilhoDe(mindmapId, idDoPai);
    },

    criarIrmao: async (idDoNo) => {
      const mindmapId = get().mapaAtivoId;
      if (!mindmapId) return;
      const arestaDoPai = get().arestas.find((aresta) => aresta.target === idDoNo);
      if (!arestaDoPai) {
        // "Irmão" = outro filho do MESMO pai. Sem pai (o nó é a raiz, ou
        // está órfão porque nasceu do "+ Cartão"), não existe irmão de
        // verdade — cai para o mesmo resultado de Tab (filho do próprio
        // nó), pra Enter nunca ser um no-op.
        await criarFilhoDe(mindmapId, idDoNo);
        return;
      }
      // O irmão herda a cor do NÓ DE REFERÊNCIA (quem recebeu o Enter), não
      // a cor recalculada a partir do pai — o pai (`arestaDoPai.source`)
      // pode ser a raiz, sem cor própria, e sem isto todo Enter abriria uma
      // cor NOVA em vez de continuar o mesmo ramo.
      const noDeReferencia = get().nos.find((no) => no.id === idDoNo);
      await criarFilhoDe(mindmapId, arestaDoPai.source, noDeReferencia?.data.color ?? null);
    },

    renomearNo: async (id, label) => {
      const mindmapId = get().mapaAtivoId;
      if (!mindmapId) return;
      const rotulo = label.trim();
      if (!rotulo) return;
      set((state) => ({
        nos: state.nos.map((no) => (no.id === id ? { ...no, data: { ...no.data, label: rotulo } } : no)),
      }));
      await aplicarMudancas(mindmapId, [{ kind: "updateNode", id, patch: { label: rotulo } }]);
    },

    definirImagemDoNo: async (id, image) => {
      const mindmapId = get().mapaAtivoId;
      if (!mindmapId) return;
      // O botão "Adicionar/Trocar/Remover imagem" só aparece no
      // `NodeToolbar` de um nó JÁ selecionado (`CartaoNode.tsx`) — captura
      // isso ANTES do `await` abaixo pra poder reaplicar depois, ver o
      // comentário no fim da função.
      const estavaSelecionado = get().nos.find((no) => no.id === id)?.selected ?? false;
      set((state) => ({
        nos: state.nos.map((no) => (no.id === id ? { ...no, data: { ...no.data, image } } : no)),
      }));
      // `patch: { image }` sempre MANDA a chave `image` (mesmo quando
      // `image` é `null`) — nunca `patch: image ? { image } : {}`, que
      // omitiria a chave no caso de remover e o backend leria como "sem
      // mudança" (ver `MindmapNodePatch.image` em `lib/ipc.ts`).
      await aplicarMudancas(mindmapId, [{ kind: "updateNode", id, patch: { image } }]);

      // A resposta do backend (aplicada por `aplicarMudancas`) substitui
      // `nos` inteiro e não carrega `selected` (não é coluna do banco) —
      // mesmo caso de `criarNoDeRamo`. Sem isto, o cartão de onde o clique
      // partiu se desselecionaria sozinho a cada troca/remoção de imagem,
      // escondendo o próprio `NodeToolbar` que o usuário estava usando —
      // ruim especialmente pra "trocar de novo" ou "remover depois de
      // trocar" em sequência. Guard de `mapaAtivoId` pelo mesmo motivo de
      // `aplicarMudancas`: o usuário pode ter trocado de mapa em voo.
      if (estavaSelecionado && get().mapaAtivoId === mindmapId) {
        set((state) => ({ nos: state.nos.map((no) => (no.id === id ? { ...no, selected: true } : no)) }));
      }
    },

    confirmarArrasto: async (nosMovidos) => {
      const mindmapId = get().mapaAtivoId;
      if (!mindmapId || nosMovidos.length === 0) return;
      const changes: MindmapChange[] = nosMovidos.map((no) => ({
        kind: "moveNode",
        id: no.id,
        position: { positionX: no.position.x, positionY: no.position.y },
      }));
      await aplicarMudancas(mindmapId, changes);
    },

    conectar: async (conexao) => {
      const mindmapId = get().mapaAtivoId;
      if (!mindmapId) return;
      const id = crypto.randomUUID();
      // `addEdge` já copia `sourceHandle`/`targetHandle` de `conexao` para a
      // aresta local (é a mesma forma) — o que falta é persistir os dois no
      // backend, senão um reload perde de qual lado a ligação saiu/chegou e
      // volta ao defeito A (ver `handlesDoEstilo`/`CartaoNode.tsx`).
      // `sourceHandle`/`targetHandle` são sempre "top"/"right"/"bottom"/
      // "left" (os ids dos handles) ou `null` num connectionMode diferente
      // de "loose" com um único handle por lado; `?? undefined` os dois
      // porque `JSON.stringify` remove chave `undefined` mas mantém `null`
      // — sem isto, `style: { sourceHandle: null }` sobreviveria na
      // gravação e `handlesDoEstilo` (que só aceita `string`) devolveria
      // `undefined` de qualquer forma, então o efeito é o mesmo, só que sem
      // gravar lixo à toa no JSON.
      const style = {
        sourceHandle: conexao.sourceHandle ?? undefined,
        targetHandle: conexao.targetHandle ?? undefined,
      };
      set((state) => ({ arestas: addEdge({ ...conexao, id }, state.arestas) }));
      await aplicarMudancas(mindmapId, [
        { kind: "createEdge", edge: { id, sourceNodeId: conexao.source, targetNodeId: conexao.target, style } },
      ]);
    },

    apagarElementos: async (nosApagados, arestasApagadas) => {
      const mindmapId = get().mapaAtivoId;
      if (!mindmapId) return;
      if (nosApagados.length === 0 && arestasApagadas.length === 0) return;
      const changes: MindmapChange[] = [
        ...nosApagados.map((no): MindmapChange => ({ kind: "deleteNode", id: no.id })),
        ...arestasApagadas.map((aresta): MindmapChange => ({ kind: "deleteEdge", id: aresta.id })),
      ];
      await aplicarMudancas(mindmapId, changes);
    },

    organizarLayoutRadial: async () => {
      const mindmapId = get().mapaAtivoId;
      if (!mindmapId) return;
      const posicoes = layoutRadial(get().nos, get().arestas);
      if (posicoes.size === 0) return;
      set((state) => ({
        nos: state.nos.map((no) => {
          const posicao = posicoes.get(no.id);
          return posicao ? { ...no, position: posicao } : no;
        }),
      }));
      const changes: MindmapChange[] = get().nos.map((no) => ({
        kind: "moveNode",
        id: no.id,
        position: { positionX: no.position.x, positionY: no.position.y },
      }));
      await aplicarMudancas(mindmapId, changes);
    },
  };
});
