import { create } from "zustand";
import {
  AppError,
  atualizarMateria as ipcAtualizarMateria,
  copiarSemana as ipcCopiarSemana,
  criarBloco as ipcCriarBloco,
  criarMateria as ipcCriarMateria,
  definirMetaSemanal as ipcDefinirMetaSemanal,
  listarMaterias as ipcListarMaterias,
  removerBloco as ipcRemoverBloco,
  removerMateria as ipcRemoverMateria,
  semanaDeEstudo,
  type AtividadeDoBloco,
  type CorDeMateria,
  type Materia,
  type PatchDeMateria,
  type SemanaDeEstudo,
} from "../../lib/ipc";
import { inicioDaSemanaLocal, somarDiasLocal } from "./date-utils";

type LoadStatus = "idle" | "loading" | "ready" | "error";

/** A visão da semana: colunas (uma lista por dia, a original) ou grade (faixa de horário × dia). As duas convivem — ver `ConteudoDeCronograma.tsx`. */
export type VisaoDoCronograma = "colunas" | "grade";

/**
 * Onde a escolha de visão sobrevive a fechar o app.
 *
 * `localStorage`, mesmo padrão manual (ler defensivamente, nunca lançar,
 * cair no padrão) de `features/navegacao/store.ts` — é posição de tela, não
 * dado do banco: não precisa de round-trip de IPC nem entra em backup.
 */
const CHAVE_VISAO = "learno:cronograma-visao";

function ehVisaoValida(valor: unknown): valor is VisaoDoCronograma {
  return valor === "colunas" || valor === "grade";
}

/** Exportado para teste direto, no mesmo padrão de `navegacao/store.ts`. */
export function lerVisaoPersistida(): VisaoDoCronograma {
  try {
    const bruto = window.localStorage.getItem(CHAVE_VISAO);
    return ehVisaoValida(bruto) ? bruto : "colunas";
  } catch {
    return "colunas";
  }
}

function gravarVisaoPersistida(visao: VisaoDoCronograma) {
  try {
    window.localStorage.setItem(CHAVE_VISAO, visao);
  } catch {
    // Storage indisponível: a escolha vale só nesta sessão.
  }
}

interface CronogramaState {
  status: LoadStatus;
  /** Erro de `load`/`definirMeta`/`criarBloco`/`removerBloco` — o banner da semana em `ConteudoDeCronograma.tsx`. Erro de matéria vive em `materiasErrorMessage`, não aqui. */
  errorMessage: string | null;
  /** Segunda-feira (`YYYY-MM-DD` local) da semana em exibição — muda ao navegar, não ao criar/remover bloco. */
  inicioDaSemana: string;
  semana: SemanaDeEstudo | null;
  visao: VisaoDoCronograma;
  materias: Materia[];
  materiasStatus: LoadStatus;
  /**
   * Erro das ações de matéria (carregar/criar/renomear/trocar cor/remover),
   * separado de `errorMessage` pelo mesmo motivo de `materiasStatus` já ser
   * separado de `status`: são dois pedaços de tela independentes
   * (`ConteudoDeCronograma` e `PainelDeMaterias`). Antes deste campo, uma
   * ação de matéria bem-sucedida limpava `errorMessage` em silêncio — inclusive
   * um erro de bloco/meta ainda não visto pelo usuário no banner da semana.
   */
  materiasErrorMessage: string | null;

  /** Carrega `inicioDaSemana` (o já guardado no estado, se omitido) — usado tanto para o load inicial quanto para recarregar depois de uma mutação, sem perder a semana em que o usuário está. */
  load: (inicioDaSemana?: string) => Promise<void>;
  semanaAnterior: () => Promise<void>;
  proximaSemana: () => Promise<void>;
  irParaHoje: () => Promise<void>;
  definirMeta: (metaMinutos: number) => Promise<void>;
  definirVisao: (visao: VisaoDoCronograma) => void;
  criarBloco: (
    dia: string,
    atividade: AtividadeDoBloco,
    minutosPlanejados: number,
    titulo?: string | null,
    deckId?: string | null,
    pageId?: string | null,
    subjectId?: string | null,
  ) => Promise<void>;
  removerBloco: (blocoId: string) => Promise<void>;

  /** Busca a lista de matérias uma vez — mesma guarda de `loadNoteTypes` em `features/cartoes/store.ts` (não só contra chamada concorrente: `"ready"` também não refaz o round-trip). */
  carregarMaterias: () => Promise<void>;
  /** Cria e insere localmente sem round-trip extra; retorna a matéria criada (mesmo padrão de `createDeck`, para quem precisa do id recém-criado). */
  criarMateria: (nome: string, cor?: CorDeMateria | null) => Promise<Materia>;
  /** Atualiza no backend e substitui a entrada local pelo objeto retornado — sem refazer `listarMaterias()`. */
  atualizarMateria: (materiaId: string, patch: PatchDeMateria) => Promise<void>;
  /**
   * Remove a matéria e recarrega a semana aberta. A recarga é obrigatória,
   * não cosmética: `study_plan_blocks.subject_id` é `ON DELETE SET NULL`
   * (migração 0029), então um bloco que apontava para esta matéria continua
   * existindo, só perde o vínculo — sem recarregar, `semana` em memória
   * ainda teria o `subjectId` antigo e a tela pintaria o bloco com uma
   * matéria que não existe mais.
   */
  removerMateria: (materiaId: string) => Promise<void>;
  /**
   * Copia os blocos de `semanaOrigemInicio` para a semana ATUALMENTE aberta
   * (`inicioDaSemana`) e recarrega essa semana ao terminar. NÃO é
   * idempotente — o backend (`copiar_semana`, ver comentário em
   * `lib/ipc.ts`) não apaga nada no destino antes de copiar, então chamar
   * duas vezes duplica os blocos. A store não bloqueia a segunda chamada:
   * quem chama precisa confirmar com o usuário antes de invocar isto.
   */
  copiarSemanaModelo: (semanaOrigemInicio: string) => Promise<void>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

export const useCronogramaStore = create<CronogramaState>((set, get) => ({
  status: "idle",
  errorMessage: null,
  inicioDaSemana: inicioDaSemanaLocal(),
  semana: null,
  visao: lerVisaoPersistida(),
  materias: [],
  materiasStatus: "idle",
  materiasErrorMessage: null,

  load: async (inicioDaSemana) => {
    // Mesma guarda de `features/cartoes/store.ts`: o React 19 em StrictMode
    // roda o efeito de montagem duas vezes em dev, e sem isto a segunda
    // chamada dispararia uma rodada de `semanaDeEstudo` concorrente e inútil.
    if (get().status === "loading") return;
    const alvo = inicioDaSemana ?? get().inicioDaSemana;
    set({ status: "loading", errorMessage: null, inicioDaSemana: alvo });
    try {
      const semana = await semanaDeEstudo(alvo);
      set({ status: "ready", semana });
    } catch (error) {
      set({ status: "error", errorMessage: messageFor(error, "Não foi possível carregar a semana.") });
    }
  },

  semanaAnterior: async () => {
    await get().load(somarDiasLocal(get().inicioDaSemana, -7));
  },

  proximaSemana: async () => {
    await get().load(somarDiasLocal(get().inicioDaSemana, 7));
  },

  irParaHoje: async () => {
    await get().load(inicioDaSemanaLocal());
  },

  definirMeta: async (metaMinutos) => {
    const inicio = get().inicioDaSemana;
    try {
      await ipcDefinirMetaSemanal(inicio, metaMinutos);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível salvar a meta semanal.") });
      throw error;
    }
    // Atualiza local sem round-trip extra: nada mais na semana já carregada mudou.
    set((state) => (state.semana ? { semana: { ...state.semana, metaMinutos }, errorMessage: null } : state));
  },

  criarBloco: async (dia, atividade, minutosPlanejados, titulo, deckId, pageId, subjectId) => {
    try {
      await ipcCriarBloco(dia, atividade, minutosPlanejados, titulo, deckId, pageId, subjectId);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível criar o bloco.") });
      throw error;
    }
    // Um bloco novo pode mudar `posicao`/`horaInicio` de vizinhos calculados
    // no backend — recarregar a semana inteira é o que reflete isso certo,
    // mesmo padrão de `deleteDeck` em `features/cartoes/store.ts`. `load()`
    // sem argumento mantém `inicioDaSemana` como está: criar um bloco nunca
    // troca de semana sozinho.
    await get().load();
  },

  removerBloco: async (blocoId) => {
    try {
      await ipcRemoverBloco(blocoId);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível remover o bloco.") });
      throw error;
    }
    await get().load();
  },

  definirVisao: (visao) => {
    set({ visao });
    gravarVisaoPersistida(visao);
  },

  carregarMaterias: async () => {
    if (get().materiasStatus === "loading" || get().materiasStatus === "ready") return;
    set({ materiasStatus: "loading" });
    try {
      const materias = await ipcListarMaterias();
      set({ materias, materiasStatus: "ready" });
    } catch (error) {
      set({
        materiasStatus: "error",
        materiasErrorMessage: messageFor(error, "Não foi possível carregar as matérias."),
      });
    }
  },

  criarMateria: async (nome, cor) => {
    try {
      const materia = await ipcCriarMateria(nome, cor);
      set((state) => ({ materias: [...state.materias, materia], materiasErrorMessage: null }));
      return materia;
    } catch (error) {
      set({ materiasErrorMessage: messageFor(error, "Não foi possível criar a matéria.") });
      throw error;
    }
  },

  atualizarMateria: async (materiaId, patch) => {
    try {
      const materia = await ipcAtualizarMateria(materiaId, patch);
      set((state) => ({
        materias: state.materias.map((m) => (m.id === materiaId ? materia : m)),
        materiasErrorMessage: null,
      }));
    } catch (error) {
      set({ materiasErrorMessage: messageFor(error, "Não foi possível atualizar a matéria.") });
      throw error;
    }
  },

  removerMateria: async (materiaId) => {
    try {
      await ipcRemoverMateria(materiaId);
    } catch (error) {
      set({ materiasErrorMessage: messageFor(error, "Não foi possível remover a matéria.") });
      throw error;
    }
    set((state) => ({
      materias: state.materias.filter((m) => m.id !== materiaId),
      materiasErrorMessage: null,
    }));
    // Obrigatório, não cosmético — ver o comentário da assinatura em `CronogramaState`:
    // um bloco que apontava para esta matéria fica com `subjectId: null` no banco
    // (ON DELETE SET NULL, migração 0029), e só `load()` traz essa verdade para cá.
    await get().load();
  },

  copiarSemanaModelo: async (semanaOrigemInicio) => {
    const semanaDestino = get().inicioDaSemana;
    try {
      await ipcCopiarSemana(semanaOrigemInicio, semanaDestino);
    } catch (error) {
      set({ errorMessage: messageFor(error, "Não foi possível copiar a semana modelo.") });
      throw error;
    }
    await get().load();
  },
}));
