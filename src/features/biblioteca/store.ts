import { create } from "zustand";
import {
  AppError,
  criarCategoria as ipcCriarCategoria,
  definirCategoriasDoLivro,
  // GRADE DE LIVROS (título/autor/ordem): `definirMetadadosDoLivro` e
  // `moverLivro` (mais abaixo) — contrato chegou em `lib/ipc.ts` nesta
  // mesma sessão, depois de esta peça ter começado a escrever contra ele.
  definirMetadadosDoLivro as ipcDefinirMetadadosDoLivro,
  importarLivro as ipcImportarLivro,
  listarCategorias,
  listarCategoriasDoLivro,
  listarCategoriasPorLivro,
  listarLivros,
  // PARTE 2 (árvore de categorias) — comando novo, ainda sem wrapper em
  // `lib/ipc.ts` nesta rodada (contrato é de quem escreve `ipc.ts`; ver
  // relatório desta tarefa). `tsc` falha SÓ nesta linha ("no exported
  // member") até o contrato chegar — deixado assim de propósito, em vez de
  // um wrapper local ou `invoke` direto.
  moverCategoria as ipcMoverCategoria,
  moverLivro as ipcMoverLivro,
  removerCategoria as ipcRemoverCategoria,
  removerLivro as ipcRemoverLivro,
  renomearCategoria as ipcRenomearCategoria,
  type Categoria,
  type LivroNaEstante,
  type ProgressoDeLeitura,
} from "../../lib/ipc";
import { gerarCapaDoLivro } from "./capa";
import { categoriaSelfAndDescendantIds, indexarCategoriasPorLivro } from "./filtro";

type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Os quatro filtros do painel — "todos" é a estante inteira, sem filtrar por `progresso.status`. */
export type FiltroDeStatus = "todos" | "unread" | "reading" | "finished";

/** A tela ativa dentro da seção Biblioteca. */
export type TelaDaBiblioteca = "estante" | "leitura";

interface BibliotecaState {
  status: LoadStatus;
  errorMessage: string | null;
  livros: LivroNaEstante[];
  filtro: FiltroDeStatus;
  /** Todas as categorias existentes, na ordem que o backend decide (`position`). */
  categorias: Categoria[];
  /** bookId -> suas categorias, indexado de `listarCategoriasPorLivro()` (ver `filtro.ts`). */
  categoriasPorLivro: Map<string, Categoria[]>;
  /** `null` = todas as categorias, sem filtrar — mesma convenção de `filtro: "todos"`. */
  filtroCategoriaId: string | null;
  tela: TelaDaBiblioteca;
  /** Livro aberto para leitura — hoje só decide qual título o placeholder de leitura mostra. */
  livroSelecionadoId: string | null;
  /** `true` enquanto um arquivo está sendo importado — trava o botão de importar contra clique duplo num arquivo grande, além da recusa por hash que o backend já faz. */
  importando: boolean;

  load: () => Promise<void>;
  setFiltro: (filtro: FiltroDeStatus) => void;
  setFiltroCategoria: (categoriaId: string | null) => void;
  /** `parentId` ausente/`null` cria na raiz — o formulário "Nova categoria" do painel continua criando lá; cada linha da árvore passa o próprio id para criar uma subcategoria dentro dela. */
  criarCategoria: (nome: string, parentId?: string | null) => Promise<void>;
  renomearCategoria: (id: string, nome: string) => Promise<void>;
  /**
   * Reparenteia `id` para `novoParentId` (`null` = raiz). Ciclo (mover para
   * dentro do próprio descendente) é recusado pelo backend
   * (`is_within_subtree`); a tela só evita OFERECER essa opção
   * (`categoriaMoveTargets` em `filtro.ts`), não reimplementa a checagem.
   */
  moverCategoria: (id: string, novoParentId: string | null) => Promise<void>;
  /**
   * Remove a categoria e as ligações dela (CASCADE) — nenhum livro é
   * apagado. D4: o backend RECUSA remover uma categoria que ainda tem
   * subcategorias (`Error::Invalid` com a contagem) — nunca promove os
   * filhos nem os apaga em cascata, então esta ação só chega a mudar o
   * estado local depois que o backend já confirmou.
   *
   * Se `id` for a categoria que hoje filtra a estante, OU UMA ANCESTRAL
   * dela (o filtro está numa subcategoria de `id`), o filtro volta para
   * "todas" — senão a estante ficaria filtrando por algo que não existe
   * mais. Antes só o caso direto existia; com árvore, o caso do ancestral
   * também precisa, porque o filtro pode estar vários níveis abaixo do que
   * foi removido.
   */
  removerCategoria: (id: string) => Promise<void>;
  /** Substitui o CONJUNTO inteiro de categorias do livro (não soma) — mesma semântica de `definirCategoriasDoLivro` no backend. */
  atribuirCategorias: (livroId: string, categoriaIds: string[]) => Promise<void>;
  importar: (caminhoDeOrigem: string) => Promise<void>;
  remover: (livroId: string) => Promise<void>;
  /**
   * Edita só o TÍTULO (autor fica intocado — `null` manda "não mude" ao IPC,
   * a mesma semântica de três estados que `definirMetadadosDoLivro`
   * documenta no backend). `titulo === ""` APAGA o título salvo: a estante
   * volta a mostrar o título derivado do nome do arquivo — não é um
   * cancelamento silencioso como em `CampoDeNomeInline` (categorias); aqui
   * "vazio" é uma confirmação válida e com efeito.
   */
  editarTituloDoLivro: (livroId: string, titulo: string) => Promise<void>;
  /** Mesma semântica de `editarTituloDoLivro`, para o autor. */
  editarAutorDoLivro: (livroId: string, autor: string) => Promise<void>;
  /**
   * Reordena a estante: o livro passa a ficar logo depois de `aposLivroId`
   * (`null` = primeiro lugar). ORDEM GLOBAL — o backend guarda UMA posição
   * por livro, não uma por grupo/categoria (ver `GradeDeLivros.tsx` para a
   * explicação de como isso convive com a estante agrupada).
   */
  moverLivro: (livroId: string, aposLivroId: string | null) => Promise<void>;
  abrirLeitura: (livroId: string) => void;
  voltarParaEstante: () => void;
  atualizarProgressoNaEstante: (livroId: string, progresso: ProgressoDeLeitura) => void;
  atualizarCapaNaEstante: (livroId: string, coverFileName: string) => void;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * PARTE 4 do contrato de capas: livros para os quais já tentamos gerar uma
 * capa NESTA SESSÃO — sucesso ou falha, nunca importa qual — e por isso não
 * tentamos de novo. Sem esta guarda, um PDF cuja extração falha sempre
 * (arquivo corrompido) tentaria de novo a cada `load()` — painel e conteúdo
 * montam juntos, e o usuário volta para a estante depois de ler outro livro
 * — a mesma falha, sempre, silenciosamente, em loop. Módulo (não estado da
 * store) de propósito: sobrevive a `useBibliotecaStore.setState()` no início
 * de cada teste, mas reseta a cada carga real do app — a mesma cadência de
 * `inMemoryUrls` em `media-storage.ts`.
 *
 * Decisão deste arquivo (o contrato deixou em aberto "botão no cartão" OU
 * "gerar sob demanda"): geração automática, sem pedir clique. Um livro já
 * importado sem capa ganha uma tentativa silenciosa assim que a estante
 * carrega; se falhar, o cartão continua mostrando o selo de formato de
 * sempre — nunca um erro visível, porque a capa é decoração, não dado que o
 * usuário precise saber que falhou.
 */
const tentativasDeCapaNestaSessao = new Set<string>();

/** Roda em segundo plano — nunca faz `load()`/`importar()` esperarem a extração de nenhum livro antes de mostrar a estante. */
function gerarCapasPendentes(livros: LivroNaEstante[]): void {
  for (const item of livros) {
    const { id, coverFileName } = item.livro;
    if (coverFileName || tentativasDeCapaNestaSessao.has(id)) continue;
    tentativasDeCapaNestaSessao.add(id);
    void gerarCapaDoLivro(id).then((novoCoverFileName) => {
      if (novoCoverFileName) useBibliotecaStore.getState().atualizarCapaNaEstante(id, novoCoverFileName);
    });
  }
}

export const useBibliotecaStore = create<BibliotecaState>((set, get) => ({
  status: "idle",
  errorMessage: null,
  livros: [],
  filtro: "todos",
  categorias: [],
  categoriasPorLivro: new Map(),
  filtroCategoriaId: null,
  tela: "estante",
  livroSelecionadoId: null,
  importando: false,

  load: async () => {
    // Painel e Conteúdo montam juntos e os dois chamam `load()` ao subir
    // (mesmo padrão de `useCartoesStore.load`); esta guarda evita duas
    // rodadas de `listarLivros` disparando ao mesmo tempo.
    if (get().status === "loading") return;
    set({ status: "loading", errorMessage: null });
    // Os livros são a estante; as categorias são como ela se organiza. As
    // duas buscas correm juntas, mas o desfecho delas é SEPARADO de
    // propósito: com um `Promise.all` único, uma falha só nas categorias
    // levava a estante inteira para a tela de erro — o usuário perdia a
    // lista de livros por causa do filtro. Agora categoria que falha vira
    // aviso, e os livros aparecem.
    const [resultadoLivros, resultadoCategorias] = await Promise.allSettled([
      listarLivros(),
      Promise.all([listarCategorias(), listarCategoriasPorLivro()]),
    ]);

    if (resultadoLivros.status === "rejected") {
      set({ status: "error", errorMessage: messageFor(resultadoLivros.reason, "Não foi possível carregar a biblioteca.") });
      return;
    }

    const livros = resultadoLivros.value;
    if (resultadoCategorias.status === "fulfilled") {
      const [categorias, categoriasPorLivroLinhas] = resultadoCategorias.value;
      set({
        status: "ready",
        livros,
        categorias,
        categoriasPorLivro: indexarCategoriasPorLivro(categoriasPorLivroLinhas),
      });
    } else {
      // Estante de pé, sem organização: lista vazia de categoria em vez de
      // manter a de uma carga anterior, que descreveria um estado que não foi
      // relido. O aviso diz o que faltou, não "erro ao carregar a biblioteca".
      set({
        status: "ready",
        livros,
        categorias: [],
        categoriasPorLivro: new Map(),
        errorMessage: messageFor(resultadoCategorias.reason, "Os livros carregaram, mas as categorias não."),
      });
    }
    gerarCapasPendentes(livros);
  },

  setFiltro: (filtro) => set({ filtro }),
  setFiltroCategoria: (categoriaId) => set({ filtroCategoriaId: categoriaId }),

  criarCategoria: async (nome, parentId) => {
    try {
      const categoria = await ipcCriarCategoria(nome, parentId ?? null);
      set((state) => ({ categorias: [...state.categorias, categoria] }));
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível criar a categoria.") });
      throw error;
    }
  },

  renomearCategoria: async (id, nome) => {
    try {
      const categoriaRenomeada = await ipcRenomearCategoria(id, nome);
      set((state) => ({
        categorias: state.categorias.map((item) => (item.id === id ? categoriaRenomeada : item)),
      }));
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível renomear a categoria.") });
      throw error;
    }
  },

  moverCategoria: async (id, novoParentId) => {
    try {
      const categoriaMovida = await ipcMoverCategoria(id, novoParentId);
      set((state) => ({
        categorias: state.categorias.map((item) => (item.id === id ? categoriaMovida : item)),
      }));
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível mover a categoria.") });
      throw error;
    }
  },

  removerCategoria: async (id) => {
    // Capturado ANTES do `await`: precisa da árvore de como ela era antes da
    // remoção para saber se o filtro atual está dentro da subárvore de `id`
    // (ver o comentário de `removerCategoria` na interface acima).
    const categoriasAntesDaRemocao = get().categorias;
    try {
      await ipcRemoverCategoria(id);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível remover a categoria.") });
      throw error;
    }
    set((state) => {
      const filtroFicaOrfao =
        state.filtroCategoriaId !== null &&
        categoriaSelfAndDescendantIds(id, categoriasAntesDaRemocao).has(state.filtroCategoriaId);
      return {
        categorias: state.categorias.filter((item) => item.id !== id),
        errorMessage: null,
        // A categoria removida pode ser justamente a que filtra a estante
        // agora, OU UMA ANCESTRAL dela — sem isto, `filtrarPorCategoria`
        // continuaria comparando contra um id que não existe mais em
        // `categorias`, e a estante pareceria vazia (o usuário acha que
        // perdeu os livros, quando só o filtro ficou órfão). Mesma guarda
        // que `remover()` já faz para `livroSelecionadoId` quando o livro
        // removido é o que está aberto.
        ...(filtroFicaOrfao ? { filtroCategoriaId: null } : {}),
      };
    });
  },

  atribuirCategorias: async (livroId, categoriaIds) => {
    try {
      await definirCategoriasDoLivro(livroId, categoriaIds);
      // Rebusca só deste livro (não a lista inteira de novo): devolve a
      // ordem de `position` que o backend decide, em vez de a tela inventar
      // uma ordenação local a partir dos ids que acabou de mandar.
      const categoriasDoLivro = await listarCategoriasDoLivro(livroId);
      set((state) => {
        const proximo = new Map(state.categoriasPorLivro);
        proximo.set(livroId, categoriasDoLivro);
        return { categoriasPorLivro: proximo };
      });
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível atualizar as categorias do livro.") });
      throw error;
    }
  },

  importar: async (caminhoDeOrigem) => {
    // Além do `disabled` do botão na tela, esta guarda cobre quem chama a
    // store diretamente (teste, ou um segundo ponto de entrada futuro):
    // nunca duas importações em voo ao mesmo tempo.
    if (get().importando) return;
    set({ importando: true, errorMessage: null });
    try {
      const novo = await ipcImportarLivro(caminhoDeOrigem);
      set((state) => ({ livros: [novo, ...state.livros], importando: false }));
      // PARTE 4 do contrato de capas: extrai DEPOIS de o livro já estar na
      // estante (o `set` acima já aconteceu) — nunca antes, e nunca
      // atrasando esta função: o `void` solta a extração em segundo plano.
      gerarCapasPendentes([novo]);
    } catch (error) {
      set({ importando: false, errorMessage: messageFor(error, "Não foi possível importar o arquivo.") });
      throw error;
    }
  },

  remover: async (livroId) => {
    try {
      await ipcRemoverLivro(livroId);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível remover o livro.") });
      throw error;
    }
    set((state) => ({
      livros: state.livros.filter((item) => item.livro.id !== livroId),
      errorMessage: null,
      ...(state.livroSelecionadoId === livroId
        ? { livroSelecionadoId: null, tela: "estante" as const }
        : {}),
    }));
  },

  editarTituloDoLivro: async (livroId, titulo) => {
    try {
      await ipcDefinirMetadadosDoLivro(livroId, titulo, null);
      // Não existe endpoint de "releia só este livro": `titulo`/`autor` em
      // `LivroNaEstante` são campos JÁ RESOLVIDOS pelo backend (metadado ou
      // nome do arquivo — a mesma regra que `definir_metadados_do_livro`
      // documenta) e recalcular isso aqui duplicaria uma regra que o Rust já
      // decide. Rebusca a estante inteira — mesma técnica de refetch pontual
      // que `atribuirCategorias` já usa, só que no grão que existe.
      const livrosAtualizados = await listarLivros();
      set({ livros: livrosAtualizados });
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível editar o título.") });
      throw error;
    }
  },

  editarAutorDoLivro: async (livroId, autor) => {
    try {
      await ipcDefinirMetadadosDoLivro(livroId, null, autor);
      const livrosAtualizados = await listarLivros();
      set({ livros: livrosAtualizados });
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível editar o autor.") });
      throw error;
    }
  },

  moverLivro: async (livroId, aposLivroId) => {
    try {
      await ipcMoverLivro(livroId, aposLivroId);
      // Mesmo motivo do refetch em `editarTituloDoLivro`: sem endpoint de
      // "releia só este livro", e aqui a ORDEM da estante inteira pode
      // mudar — rebusca tudo, já na ordem nova que o backend decidiu.
      const livrosAtualizados = await listarLivros();
      set({ livros: livrosAtualizados });
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível reordenar o livro.") });
      throw error;
    }
  },

  abrirLeitura: (livroId) => set({ tela: "leitura", livroSelecionadoId: livroId }),

  voltarParaEstante: () => set({ tela: "estante", livroSelecionadoId: null }),

  // O leitor (fora desta store) chama isto a cada virada de página. Sem ele,
  // o card na estante continuaria mostrando o progresso de quando o livro
  // foi aberto até a lista inteira recarregar — a mesma barra que já existe
  // aqui só fica correta se os dois lados dividirem uma fonte da verdade.
  atualizarProgressoNaEstante: (livroId, progresso) =>
    set((state) => ({
      livros: state.livros.map((item) => (item.livro.id === livroId ? { ...item, progresso } : item)),
    })),

  // `gerarCapasPendentes` chama isto quando uma extração em segundo plano
  // termina — mesmo padrão de `atualizarProgressoNaEstante`, atualizando só
  // o livro que mudou em vez de recarregar a lista inteira.
  atualizarCapaNaEstante: (livroId, coverFileName) =>
    set((state) => ({
      livros: state.livros.map((item) =>
        item.livro.id === livroId ? { ...item, livro: { ...item.livro, coverFileName } } : item,
      ),
    })),
}));
