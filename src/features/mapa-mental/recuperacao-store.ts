import { create } from "zustand";

/**
 * Modo de recuperação ativa (item 1 do briefing desta peça): esconde o texto
 * dos nós e deixa só a estrutura (caixas + arestas) visível, para o usuário
 * tentar LEMBRAR o que cada nó dizia antes de revelar — é a prática que
 * consolida memória; olhar a resposta pronta direto não.
 *
 * Store SEPARADA de `useMapaMentalStore` de propósito, no mesmo espírito de
 * `criar-cartao-de-no-store.ts`: nada aqui é dado do mapa (nunca chega a
 * `mindmap_nodes`), é só estado transitório de UMA sessão de revisão na tela.
 * Nenhuma ação daqui chama IPC — é a garantia de que entrar/sair do modo
 * nunca escreve no banco (briefing: "é um modo de LEITURA").
 *
 * `revelados` guarda só os nós que o usuário já revelou NESTA passada pelo
 * modo — sai do modo (`sair`) e a próxima entrada (`iniciar`) começa de novo
 * com tudo oculto, mesmo sem sair da tela. O nó raiz nunca entra aqui: ele é
 * sempre visível (é a deixa de contexto — ver o comentário de `souRaiz` em
 * `CartaoNode.tsx`), então checar "está revelado" nele nunca precisa ser
 * consultado.
 */
interface RecuperacaoState {
  ativo: boolean;
  revelados: Set<string>;
  /** Id do nó sob o "cursor" de navegação por teclado — só existe com `ativo`. */
  focoId: string | null;

  /** Liga o modo, zera o que estava revelado de uma passada anterior e põe o cursor no nó indicado (tipicamente o raiz). */
  iniciar: (focoInicialId: string | null) => void;
  /** Desliga o modo e descarta `revelados`/`focoId` — não mexe no mapa em si. */
  sair: () => void;
  revelar: (id: string) => void;
  revelarTodos: (ids: string[]) => void;
  focar: (id: string) => void;
}

export const useRecuperacaoStore = create<RecuperacaoState>((set) => ({
  ativo: false,
  revelados: new Set(),
  focoId: null,

  iniciar: (focoInicialId) => set({ ativo: true, revelados: new Set(), focoId: focoInicialId }),

  sair: () => set({ ativo: false, revelados: new Set(), focoId: null }),

  revelar: (id) =>
    set((state) => {
      if (state.revelados.has(id)) return state;
      const revelados = new Set(state.revelados);
      revelados.add(id);
      return { revelados };
    }),

  revelarTodos: (ids) => set({ revelados: new Set(ids) }),

  focar: (id) => set({ focoId: id }),
}));
