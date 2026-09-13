import { create } from "zustand";
import {
  AppError,
  anexarMaterialEtapa as anexarMaterialEtapaIpc,
  apagarFlecha as apagarFlechaIpc,
  createPage,
  createProperty,
  criarEtapa as criarEtapaIpc,
  criarFlecha as criarFlechaIpc,
  criarRaia as criarRaiaIpc,
  criarTrilhaCompleta,
  deckMaturity as deckMaturityIpc,
  definirPropriedadeDeAgrupamentoDaTrilha,
  definirRaiaRecolhida as definirRaiaRecolhidaIpc,
  desmarcarEtapaComoDecisao as desmarcarEtapaComoDecisaoIpc,
  desmarcarProgressoEtapa as desmarcarProgressoEtapaIpc,
  escolherCaminho as escolherCaminhoIpc,
  listProperties,
  listarTrilhas,
  marcarEtapaComoDecisao as marcarEtapaComoDecisaoIpc,
  marcarProgressoEtapa as marcarProgressoEtapaIpc,
  movePage,
  moverEtapaParaRaia as moverEtapaParaRaiaIpc,
  obterTrilha,
  preverTrocaDeCaminho as preverTrocaDeCaminhoIpc,
  removerEtapa as removerEtapaIpc,
  removerMaterialEtapa as removerMaterialEtapaIpc,
  removerRaia as removerRaiaIpc,
  renameDatabase,
  renamePage,
  renameView,
  renomearCaminho as renomearCaminhoIpc,
  renomearRaia as renomearRaiaIpc,
  reordenarRaia as reordenarRaiaIpc,
  trashPage,
  type Decisao,
  type DeckMaturity,
  type ImpactoDaTroca,
  type SiblingPosition,
  type Trilha,
  type TrilhaResumo,
} from "../../lib/ipc";
import { lerLocalizacaoDaTrilha, limparLocalizacaoDaTrilha, salvarLocalizacaoDaTrilha } from "./localizacao";

/**
 * Nome fixo da página-container e do database/view que `criarPrimeiraTrilha`
 * cria. O usuário pode renomear a página depois em Notas (é uma página comum
 * dali em diante) — este texto só precisa existir uma vez, no nascimento.
 */
const NOME_PADRAO_DA_TRILHA = "Trilha";

/**
 * Nome da propriedade `select` que agrupa as etapas em raias. É o identificador
 * de fato que `ativarRaias` procura antes de criar — por isso mora numa
 * constante, e não solto na chamada.
 */
const NOME_DA_PROPRIEDADE_DE_RAIA = "Raia";

type StatusDaTrilha =
  | "carregando"
  /** Nenhuma Trilha localizada — nem no ponteiro local, nem no que ele apontava. Mostra o convite de criar. */
  | "vazia"
  | "pronta"
  | "erro";

type StatusDaLista = "idle" | "loading" | "ready" | "error";

/**
 * O estado de UMA busca de `deckMaturity` no cache de `maturidadesPorBaralho`
 * — ver o comentário de `carregarMaturidadeDoBaralho` para a estratégia
 * inteira. Ausência de entrada no mapa (nenhuma das três variantes) é um
 * quarto estado implícito: "nunca foi pedida ainda".
 */
type EstadoDaMaturidade =
  | { status: "carregando" }
  | { status: "pronta"; maturidade: DeckMaturity }
  | { status: "erro"; mensagem: string };

interface TrilhaState {
  status: StatusDaTrilha;
  viewId: string | null;
  /** `databaseId` da trilha ATIVA — `ConfiguracaoTrilha` não carrega isto (só `viewId`), e `ativarRaias`/`renomearTrilha` precisam dele. Vem do resumo (`TrilhaResumo`) que a criou ou que a selecionou; `null` só entre o momento em que `obterTrilha` já respondeu e `listarTrilhas` ainda não (ver `carregar`). */
  databaseId: string | null;
  trilha: Trilha | null;
  /** Derivado de `trilha.decisoes` — ver `mapaDeDecisoesDe`. `new Map()` enquanto `trilha` é `null`. */
  mapaDeDecisoes: Map<string, Decisao>;
  /** Erro de carregar ou de uma ação (criar etapa, ligar flecha…). A tela nunca vira branca por causa dele — ver `ConteudoDeTrilha.tsx`. */
  errorMessage: string | null;
  /**
   * Cache de `deckMaturity` por `deckId` — nunca por etapa. Ver o comentário
   * de `carregarMaturidadeDoBaralho` para a estratégia de busca completa.
   */
  maturidadesPorBaralho: Map<string, EstadoDaMaturidade>;

  /** A lista de trilhas do painel — independente do `status` da trilha ATIVA acima (o painel mostra a lista mesmo com o conteúdo em erro ou vazio). */
  listaStatus: StatusDaLista;
  trilhas: TrilhaResumo[];
  /** `viewId` da trilha que acabou de nascer por "+ Nova trilha" e ainda precisa entrar em modo de edição de nome assim que a linha do painel renderizar — mesmo papel de `pendingRenameId` em `features/mapa-mental/store.ts`. */
  pendingRenameId: string | null;
  /** Só para o botão "+ Nova trilha" do painel mostrar "Criando…" sem tocar em `status` (que pertence à trilha ATIVA, que pode já estar com conteúdo na tela). */
  criandoTrilha: boolean;

  /** Lê o ponteiro salvo e busca a Trilha; sem ponteiro, cai em "vazia" sem chamada nenhuma. */
  carregar: () => Promise<void>;
  /** A lista para o painel — chamada por `PainelDeTrilha` no próprio mount, independente de `carregar`. */
  carregarTrilhas: () => Promise<void>;
  /** Troca a trilha ativa para uma já existente (uma linha do painel). */
  selecionarTrilha: (viewId: string) => Promise<void>;
  /**
   * Cria a página-container e a Trilha completa dentro dela (uma raia só,
   * sem título — TRL-014). As duas chamadas NÃO são atômicas entre si: se a
   * segunda falhar, a página já criada fica na árvore de Notas, órfã, e o
   * erro conta isso ao usuário em vez de escondê-lo.
   */
  criarPrimeiraTrilha: () => Promise<void>;
  /** "+ Nova trilha" do painel — mesmo caminho de `criarPrimeiraTrilha`, mas nomeável e sem exigir que não haja trilha ativa (mexe só em `criandoTrilha`, não em `status`, até o sucesso). */
  criarNovaTrilha: (nome: string) => Promise<void>;
  consumePendingRename: (viewId: string) => void;
  /**
   * Renomeia database + view + página-container juntos — os três nascem com
   * o mesmo nome em `criarPrimeiraTrilha`/`criarNovaTrilha` (`criarTrilhaCompleta`,
   * `src-tauri/src/ipc/trilha_commands.rs`), e é esse trio que o painel mostra
   * como "o nome da trilha". Antes desta correção só database+view eram
   * renomeados — a página congelava no título de criação e divergia em
   * silêncio (o título aparece em Notas/breadcrumb, os outros dois no painel
   * da Trilha). Usa os comandos que já existiam (`rename_database`/
   * `rename_view`/`rename_page`) em vez de abrir um caminho novo.
   */
  renomearTrilha: (viewId: string, databaseId: string, containerPageId: string, nome: string) => Promise<void>;
  /** Manda a página-container para a lixeira — reversível, mesmo caminho de apagar qualquer página de Notas (não um "apagar trilha" dedicado e definitivo, que não existe no contrato). */
  apagarTrilha: (viewId: string, containerPageId: string) => Promise<void>;
  /**
   * Destrava raia nomeada numa trilha que nasceu sem propriedade de
   * agrupamento (o único caminho que a criação oferece): cria uma
   * propriedade `select` chamada "Raia" na database da trilha ATIVA e a
   * configura como agrupadora. Sem isto, quem já tinha uma trilha ficaria
   * para sempre preso à raia única — é a trava que o usuário sentiu.
   */
  ativarRaias: () => Promise<void>;
  criarRaia: (laneValue: string) => Promise<void>;
  renomearRaia: (valorAtual: string, novoValor: string) => Promise<void>;
  /** `aposLaneValue` nulo põe a raia em primeiro. */
  reordenarRaia: (laneValue: string, aposLaneValue: string | null) => Promise<void>;
  /**
   * Apaga a raia. NUNCA apaga as etapas que estavam nela — elas ficam sem
   * raia (TRL-014). A tela decide sozinha se avisa antes: este método só
   * escreve, a contagem de "quantas etapas vão para Sem raia" é derivada de
   * `trilha.etapas` no componente, antes de chamar isto.
   */
  apagarRaia: (laneValue: string) => Promise<void>;
  moverEtapaParaRaia: (stepId: string, laneValue: string) => Promise<void>;
  /**
   * Reordena verticalmente DENTRO da mesma raia (arrastar mais para cima/
   * baixo, sem trocar de faixa). Por baixo é `movePage(stepId, null, target)`
   * — a investigação desta entrega fechou que uma etapa nunca tem
   * `parent_id` (`create_record` nunca grava um), então os "irmãos" que
   * `movePage` reordena são todo mundo com `parent_id = NULL` no app
   * inteiro, não só as etapas desta trilha. Isso não é problema: `position`
   * é um índice fracionário TOTAL, comparável em qualquer subconjunto, e
   * filtrar um conjunto totalmente ordenado por raia/nível depois nunca
   * inverte a ordem relativa do que sobra — ver o comentário de
   * `EtapaDaTrilha.position` em `lib/ipc.ts` e `alvoDeReordenacaoNaRaia` em
   * `arrasto-de-raia.ts`, que decide QUAL `target` mandar.
   */
  reordenarEtapa: (stepId: string, target: SiblingPosition) => Promise<void>;
  anexarMaterial: (
    stepId: string,
    kind: "page" | "deck" | "book",
    pageId: string | null,
    deckId: string | null,
  ) => Promise<void>;
  removerMaterial: (materialId: string) => Promise<void>;
  /**
   * Busca `deckMaturity(deckId)` e guarda no cache — ver o comentário do
   * campo `maturidadesPorBaralho` e o do corpo desta função (dentro do
   * `create`) para a estratégia completa. Não segue `executarEReler`: isto
   * não é uma mutação da Trilha, é leitura de um baralho, e um erro aqui é
   * mostrado ao lado do material que falhou, não no banner global.
   */
  carregarMaturidadeDoBaralho: (deckId: string) => Promise<void>;
  criarEtapa: (title: string, laneValue: string) => Promise<void>;
  /** Renomeia a etapa — por baixo é `renamePage`: uma etapa É uma página-registro, não existe comando dedicado. */
  renomearEtapa: (stepId: string, title: string) => Promise<void>;
  /**
   * Apaga (manda para a lixeira de Notas) a etapa — reversível via
   * `restorePage`. NÃO religa a cadeia sozinho: numa A → B → C, apagar B
   * deixa C desbloqueada, sem virar bloqueada por A. A tela decide sozinha se
   * avisa antes disso — este método só escreve.
   */
  apagarEtapa: (stepId: string) => Promise<void>;
  criarFlecha: (blockedId: string, blockingId: string, pathLabel?: string | null) => Promise<void>;
  apagarFlecha: (blockedId: string, blockingId: string) => Promise<void>;
  marcarProgresso: (stepId: string, estado: "in_progress" | "done") => Promise<void>;
  desmarcarProgresso: (stepId: string) => Promise<void>;
  definirRaiaRecolhida: (laneValue: string, recolhida: boolean) => Promise<void>;
  /** Marca a etapa como decisão — ela passa a ramificar em vez de só desbloquear a próxima. Idempotente no backend: marcar duas vezes não é erro. */
  marcarComoDecisao: (stepId: string) => Promise<void>;
  /** Desfaz a marcação. O backend RECUSA enquanto existir caminho rotulado saindo dela — a mensagem do `AppError` já explica o motivo. */
  desmarcarDecisao: (stepId: string) => Promise<void>;
  /** Escolhe um caminho, ou zera a escolha com `rotulo: null`. Nenhum progresso é apagado. */
  escolherCaminho: (decisionId: string, rotulo: string | null) => Promise<void>;
  /** Renomeia um caminho, ou o dissolve (`novoRotulo` nulo vira pré-requisito incondicional). */
  renomearCaminho: (decisionId: string, rotuloAtual: string, novoRotulo: string | null) => Promise<void>;
  /**
   * Leitura pura: NÃO muda a store nem relê a trilha, só devolve o
   * `ImpactoDaTroca` para a TELA decidir o que mostrar antes de confirmar
   * `escolherCaminho`. Por isso não segue `executarEReler` — não há mutação
   * para reconciliar, e um erro aqui é problema do diálogo de confirmação
   * (que decide como mostrar), não do banner global de `errorMessage`.
   */
  preverTrocaDeCaminho: (decisionId: string, novoRotulo: string | null) => Promise<ImpactoDaTroca>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * Mesmo padrão de `childrenIndex` em `features/pages/store.ts`: um índice
 * derivado do dado bruto (`trilha.decisoes`), recalculado no ÚNICO lugar que
 * troca `trilha` — não em cada nó a cada render, que é o "varrer
 * trilha.decisoes a cada render de cada nó" que a tela evitaria de outro
 * jeito. Responde de graça as duas perguntas que `EtapaNode` faria: "esta
 * etapa é uma decisão?" (`.has(stepId)`) e "qual o rótulo escolhido?"
 * (`.get(stepId)?.chosenLabel`).
 */
function mapaDeDecisoesDe(decisoes: Decisao[]): Map<string, Decisao> {
  return new Map(decisoes.map((decisao) => [decisao.stepId, decisao] as const));
}

export const useTrilhaStore = create<TrilhaState>((set, get) => {
  /**
   * O funil único de toda escrita: chama `executar`, e SÓ em caso de sucesso
   * relê a trilha inteira do backend — nunca calcula nível/desbloqueio no
   * cliente (ambos são derivados do grafo, no servidor). Falha de `executar`
   * não relê nada: o que está na tela ainda é a verdade (não houve edição
   * otimista pra reconciliar), só o aviso muda.
   */
  async function executarEReler(mensagemDeErro: string, executar: (viewId: string) => Promise<unknown>): Promise<void> {
    const viewId = get().viewId;
    if (!viewId) return;

    try {
      await executar(viewId);
    } catch (error) {
      set({ errorMessage: messageFor(error, mensagemDeErro) });
      return;
    }

    try {
      const trilha = await obterTrilha(viewId);
      set({ trilha, mapaDeDecisoes: mapaDeDecisoesDe(trilha.decisoes), errorMessage: null });
    } catch (error) {
      set({ errorMessage: messageFor(error, "A ação foi salva, mas não foi possível recarregar a trilha.") });
    }
  }

  /**
   * Núcleo compartilhado de `criarPrimeiraTrilha`/`criarNovaTrilha`: as duas
   * terminam fazendo a MESMA coisa — criar a página-container e a trilha
   * completa dentro dela —, só diferem em ONDE a criação em voo aparece.
   * `comoUnica: true` (o caminho de `EstadoVazioDeTrilha`, sem trilha ativa
   * nenhuma) usa `status` para a tela inteira mostrar "Criando…"; `false` (o
   * "+ Nova trilha" do painel, que pode rodar com uma trilha JÁ aberta no
   * canvas) usa `criandoTrilha` para não apagar o que já está na tela.
   */
  async function criarTrilhaInterna(nome: string, comoUnica: boolean): Promise<void> {
    const tituloFinal = nome.trim() || NOME_PADRAO_DA_TRILHA;
    if (comoUnica) set({ status: "carregando", errorMessage: null });
    else set({ criandoTrilha: true, errorMessage: null });

    const pagina = await createPage(null, tituloFinal).catch((error: unknown) => {
      const mensagem = messageFor(error, "Não foi possível criar a página da Trilha.");
      if (comoUnica) set({ status: "vazia", errorMessage: mensagem });
      else set({ criandoTrilha: false, errorMessage: mensagem });
      return null;
    });
    if (!pagina) return;

    try {
      const recemCriada = await criarTrilhaCompleta(pagina.id, tituloFinal, tituloFinal, null);
      const viewId = recemCriada.trilha.configuracao.viewId;
      salvarLocalizacaoDaTrilha({ containerPageId: pagina.id, viewId });
      const resumo: TrilhaResumo = {
        viewId,
        databaseId: recemCriada.databaseId,
        containerPageId: pagina.id,
        nome: tituloFinal,
        createdAt: recemCriada.trilha.configuracao.createdAt,
        updatedAt: recemCriada.trilha.configuracao.updatedAt,
      };
      set((state) => ({
        status: "pronta",
        viewId,
        databaseId: recemCriada.databaseId,
        trilha: recemCriada.trilha,
        mapaDeDecisoes: mapaDeDecisoesDe(recemCriada.trilha.decisoes),
        errorMessage: null,
        criandoTrilha: false,
        trilhas: [...state.trilhas, resumo],
        // Só o "+ Nova trilha" do painel entra direto em edição de nome — a
        // primeira trilha do app já nasce com o nome definitivo escolhido
        // por `NOME_PADRAO_DA_TRILHA`, sem convite de renomear na hora.
        pendingRenameId: comoUnica ? state.pendingRenameId : viewId,
      }));
    } catch (error) {
      // A página ficou criada (ver o comentário de `criarTrilhaCompleta` em
      // lib/ipc.ts sobre a falta de atomicidade) — ela aparece em Notas,
      // vazia, e o usuário decide o que fazer com ela. Voltar para "vazia"
      // (em vez de "erro") mantém o convite de tentar de novo na tela.
      const mensagem = `A página "${tituloFinal}" foi criada, mas não foi possível montar a trilha nela: ${messageFor(error, "erro desconhecido")}. Ela ficou salva em Notas — pode reaproveitar ou apagar de lá antes de tentar de novo.`;
      if (comoUnica) set({ status: "vazia", errorMessage: mensagem });
      else set({ criandoTrilha: false, errorMessage: mensagem });
    }
  }

  return {
    status: "carregando",
    viewId: null,
    databaseId: null,
    trilha: null,
    mapaDeDecisoes: new Map(),
    errorMessage: null,
    maturidadesPorBaralho: new Map(),

    listaStatus: "idle",
    trilhas: [],
    pendingRenameId: null,
    criandoTrilha: false,

    carregar: async () => {
      const localizacao = lerLocalizacaoDaTrilha();
      if (!localizacao) {
        set({ status: "vazia", viewId: null, databaseId: null, trilha: null, mapaDeDecisoes: new Map(), errorMessage: null });
        return;
      }

      set({ status: "carregando", errorMessage: null });
      try {
        const trilha = await obterTrilha(localizacao.viewId);
        set({ status: "pronta", viewId: localizacao.viewId, trilha, mapaDeDecisoes: mapaDeDecisoesDe(trilha.decisoes), errorMessage: null });
      } catch (error) {
        set({ status: "erro", viewId: localizacao.viewId, errorMessage: messageFor(error, "Não foi possível carregar a trilha.") });
        return;
      }

      // `databaseId` não é crítico para MOSTRAR a trilha (só para
      // `ativarRaias`/renomear a partir do painel) — falha aqui não derruba
      // a tela que já está "pronta" acima. `trilhas` também é preenchido de
      // graça aqui, então o painel (se montar depois) já encontra a lista
      // pronta em vez de refazer a mesma chamada.
      try {
        const trilhas = await listarTrilhas();
        const resumo = trilhas.find((item) => item.viewId === localizacao.viewId);
        set({ trilhas, listaStatus: "ready", databaseId: resumo?.databaseId ?? null });
      } catch {
        // O painel mostra seu próprio erro quando `carregarTrilhas` rodar.
      }
    },

    carregarTrilhas: async () => {
      set({ listaStatus: "loading", errorMessage: null });
      try {
        const trilhas = await listarTrilhas();
        set({ listaStatus: "ready", trilhas });
      } catch (error) {
        set({ listaStatus: "error", errorMessage: messageFor(error, "Não foi possível carregar as trilhas.") });
      }
    },

    selecionarTrilha: async (viewId) => {
      if (get().viewId === viewId && get().status === "pronta") return;
      const resumo = get().trilhas.find((item) => item.viewId === viewId);
      if (!resumo) {
        set({ errorMessage: "Esta trilha não está mais na lista — atualize o painel e tente de novo." });
        return;
      }
      set({ status: "carregando", viewId, databaseId: resumo.databaseId, errorMessage: null });
      try {
        const trilha = await obterTrilha(viewId);
        // O usuário pode ter trocado de novo enquanto isto estava em voo.
        if (get().viewId !== viewId) return;
        salvarLocalizacaoDaTrilha({ containerPageId: resumo.containerPageId, viewId });
        set({ status: "pronta", trilha, mapaDeDecisoes: mapaDeDecisoesDe(trilha.decisoes), errorMessage: null });
      } catch (error) {
        if (get().viewId !== viewId) return;
        set({ status: "erro", errorMessage: messageFor(error, "Não foi possível carregar esta trilha.") });
      }
    },

    criarPrimeiraTrilha: () => criarTrilhaInterna(NOME_PADRAO_DA_TRILHA, true),

    criarNovaTrilha: (nome) => criarTrilhaInterna(nome, false),

    consumePendingRename: (viewId) => {
      if (get().pendingRenameId === viewId) set({ pendingRenameId: null });
    },

    renomearTrilha: async (viewId, databaseId, containerPageId, nome) => {
      const tituloFinal = nome.trim();
      if (!tituloFinal) return;
      try {
        // As três escritas não formam uma transação (são três comandos IPC
        // independentes, cada um comitando sozinho) — se uma falhar, as
        // outras que já tiverem passado ficam gravadas mesmo assim. Em vez
        // de tentar adivinhar aqui qual sobreviveu, o `catch` abaixo relê
        // `listarTrilhas()` do servidor, o mesmo "recarrega e mostra o que é
        // verdade" que `executarEReler` já faz para toda outra escrita do
        // store — a UI nunca fica mentindo um nome que não colou nos três
        // lugares.
        await Promise.all([
          renameDatabase(databaseId, tituloFinal),
          renameView(viewId, tituloFinal),
          renamePage(containerPageId, tituloFinal),
        ]);
        set((state) => ({
          errorMessage: null,
          trilhas: state.trilhas.map((item) => (item.viewId === viewId ? { ...item, nome: tituloFinal } : item)),
        }));
      } catch (error) {
        const mensagem = messageFor(error, "Não foi possível renomear a trilha.");
        try {
          const trilhas = await listarTrilhas();
          set({ trilhas, errorMessage: mensagem });
        } catch {
          // Nem a releitura de recuperação respondeu — a lista em tela pode
          // estar desatualizada, mas não há dado novo para substituí-la, e o
          // aviso de erro já é o que importa mostrar.
          set({ errorMessage: mensagem });
        }
      }
    },

    apagarTrilha: async (viewId, containerPageId) => {
      try {
        await trashPage(containerPageId);
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível apagar a trilha.") });
        return;
      }
      if (lerLocalizacaoDaTrilha()?.viewId === viewId) limparLocalizacaoDaTrilha();
      set((state) => ({
        errorMessage: null,
        trilhas: state.trilhas.filter((item) => item.viewId !== viewId),
        pendingRenameId: state.pendingRenameId === viewId ? null : state.pendingRenameId,
        ...(state.viewId === viewId
          ? { status: "vazia" as const, viewId: null, databaseId: null, trilha: null, mapaDeDecisoes: new Map() }
          : {}),
      }));
    },

    ativarRaias: async () => {
      const { viewId, databaseId } = get();
      if (!viewId || !databaseId) return;
      try {
        // Reaproveita a propriedade "Raia" se ela já existir, em vez de criar
        // outra. São DUAS escritas que não formam uma transação (criar a
        // propriedade, depois apontar a view para ela): se a segunda falhar,
        // a propriedade fica órfã na database, e o retry natural do usuário —
        // clicar "Ativar raias" de novo — criaria uma segunda propriedade com
        // o mesmo nome. Procurar antes torna o retry idempotente sem precisar
        // de um comando novo no backend.
        const existente = (await listProperties(databaseId)).find(
          (propriedade) => propriedade.propertyType === "select" && propriedade.name === NOME_DA_PROPRIEDADE_DE_RAIA,
        );
        const propriedade = existente ?? (await createProperty(databaseId, NOME_DA_PROPRIEDADE_DE_RAIA, "select"));
        await definirPropriedadeDeAgrupamentoDaTrilha(viewId, propriedade.id);
      } catch (error) {
        set({ errorMessage: messageFor(error, "Não foi possível ativar as raias nesta trilha.") });
        return;
      }
      try {
        const trilha = await obterTrilha(viewId);
        if (get().viewId !== viewId) return;
        set({ trilha, mapaDeDecisoes: mapaDeDecisoesDe(trilha.decisoes), errorMessage: null });
      } catch (error) {
        set({ errorMessage: messageFor(error, "As raias foram ativadas, mas não foi possível recarregar a trilha.") });
      }
    },

    criarRaia: (laneValue) => executarEReler("Não foi possível criar a raia.", (viewId) => criarRaiaIpc(viewId, laneValue)),

    renomearRaia: (valorAtual, novoValor) =>
      executarEReler("Não foi possível renomear a raia.", (viewId) => renomearRaiaIpc(viewId, valorAtual, novoValor)),

    reordenarRaia: (laneValue, aposLaneValue) =>
      executarEReler("Não foi possível reordenar a raia.", (viewId) => reordenarRaiaIpc(viewId, laneValue, aposLaneValue)),

    apagarRaia: (laneValue) => executarEReler("Não foi possível apagar a raia.", (viewId) => removerRaiaIpc(viewId, laneValue)),

    moverEtapaParaRaia: (stepId, laneValue) =>
      executarEReler("Não foi possível mover a etapa de raia.", (viewId) => moverEtapaParaRaiaIpc(stepId, viewId, laneValue)),

    reordenarEtapa: (stepId, target) =>
      executarEReler("Não foi possível reordenar a etapa.", () => movePage(stepId, null, target)),

    anexarMaterial: (stepId, kind, pageId, deckId) =>
      executarEReler("Não foi possível anexar o material.", () => anexarMaterialEtapaIpc(stepId, kind, pageId, deckId)),

    removerMaterial: (materialId) =>
      executarEReler("Não foi possível remover o material.", () => removerMaterialEtapaIpc(materialId)),

    /**
     * ESTRATÉGIA DE BUSCA (item 3 do pedido): `deck_maturity` agrega o
     * baralho inteiro no SQLite a cada chamada — barato para UM baralho, mas
     * a Trilha pode ter 20+ etapas, e a maioria delas nunca é aberta na mesma
     * sessão. Buscar tudo no mount (como `useCartoesStore.carregarContagens`
     * faz para `deckCounts`, que é O(1) por linha) pagaria por maturidade que
     * ninguém olha; buscar a cada render duplicaria a mesma chamada sem
     * motivo. A escolha foi:
     *
     * 1. `EtapaNode` só CHAMA isto quando o material de baralho de fato
     *    aparece na tela — dentro do `NodeToolbar`, que só existe com a
     *    etapa selecionada (ver o `useEffect` lá). Etapa nunca aberta nunca
     *    dispara IPC nenhum.
     * 2. Cache aqui por `deckId`, não por etapa: reabrir a mesma etapa, ou
     *    duas etapas que apontam para o MESMO baralho, reaproveitam a mesma
     *    entrada. O early-return abaixo, escrito ANTES do primeiro `await`,
     *    também corta o caso de duas etapas selecionadas em sequência rápida
     *    pedirem o mesmo `deckId` — a segunda já encontra `"carregando"`.
     *
     * Custo aceito: responder um cartão do baralho não invalida a entrada —
     * a fração de maduros pode ficar um pouco desatualizada até a etapa ser
     * fechada e reaberta (ou a Trilha inteira recarregar). Aceitável porque
     * isto é só um indicador visual, não um gate de desbloqueio.
     */
    carregarMaturidadeDoBaralho: async (deckId) => {
      if (get().maturidadesPorBaralho.has(deckId)) return;
      set((state) => ({
        maturidadesPorBaralho: new Map(state.maturidadesPorBaralho).set(deckId, { status: "carregando" }),
      }));
      try {
        const maturidade = await deckMaturityIpc(deckId);
        set((state) => ({
          maturidadesPorBaralho: new Map(state.maturidadesPorBaralho).set(deckId, { status: "pronta", maturidade }),
        }));
      } catch (error) {
        set((state) => ({
          maturidadesPorBaralho: new Map(state.maturidadesPorBaralho).set(deckId, {
            status: "erro",
            mensagem: messageFor(error, "Não foi possível carregar a maturidade deste baralho."),
          }),
        }));
      }
    },

    criarEtapa: (title, laneValue) =>
      executarEReler("Não foi possível criar a etapa.", (viewId) => criarEtapaIpc(viewId, title, laneValue)),

    renomearEtapa: (stepId, title) =>
      executarEReler("Não foi possível renomear a etapa.", () => renamePage(stepId, title)),

    apagarEtapa: (stepId) => executarEReler("Não foi possível apagar a etapa.", () => removerEtapaIpc(stepId)),

    // `pathLabel` default `null` (não `undefined`): quem chama sem o
    // terceiro argumento está ligando uma bloqueadora comum — pré-requisito
    // incondicional, o mesmo valor que `TrilhaCanvas.tsx` passa explicitamente
    // no caso análogo (`argumentos.pathLabel === null`).
    criarFlecha: (blockedId, blockingId, pathLabel = null) =>
      executarEReler("Não foi possível ligar as duas etapas.", () => criarFlechaIpc(blockedId, blockingId, pathLabel)),

    apagarFlecha: (blockedId, blockingId) =>
      executarEReler("Não foi possível apagar a flecha.", () => apagarFlechaIpc(blockedId, blockingId)),

    marcarProgresso: (stepId, estado) =>
      executarEReler(
        estado === "done" ? "Não foi possível marcar a etapa como concluída." : "Não foi possível marcar a etapa como em andamento.",
        () => marcarProgressoEtapaIpc(stepId, estado),
      ),

    desmarcarProgresso: (stepId) =>
      executarEReler("Não foi possível desmarcar o progresso da etapa.", () => desmarcarProgressoEtapaIpc(stepId)),

    definirRaiaRecolhida: (laneValue, recolhida) =>
      executarEReler("Não foi possível recolher a raia.", (viewId) => definirRaiaRecolhidaIpc(viewId, laneValue, recolhida)),

    marcarComoDecisao: (stepId) =>
      executarEReler("Não foi possível marcar esta etapa como decisão.", () => marcarEtapaComoDecisaoIpc(stepId)),

    desmarcarDecisao: (stepId) =>
      executarEReler("Não foi possível desfazer esta decisão.", () => desmarcarEtapaComoDecisaoIpc(stepId)),

    escolherCaminho: (decisionId, rotulo) =>
      executarEReler("Não foi possível escolher o caminho.", () => escolherCaminhoIpc(decisionId, rotulo)),

    renomearCaminho: (decisionId, rotuloAtual, novoRotulo) =>
      executarEReler("Não foi possível renomear o caminho.", () => renomearCaminhoIpc(decisionId, rotuloAtual, novoRotulo)),

    // Leitura pura — sem `executarEReler`: não há mutação a reconciliar, e o
    // erro (se houver) é decisão de quem chamou (ex.: mostrar inline no
    // diálogo de confirmação), não do banner global de `errorMessage`.
    preverTrocaDeCaminho: (decisionId, novoRotulo) => preverTrocaDeCaminhoIpc(decisionId, novoRotulo),
  };
});
