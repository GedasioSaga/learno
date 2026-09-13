import { create } from "zustand";
import { ehSecaoId, type SecaoId } from "./contrato";

/**
 * Como a última troca de seção aconteceu. Decide se o conteúdo anima ao
 * entrar: troca pelo mouse anima (feedback de "de onde veio"); troca por
 * atalho de teclado não (§9.3 do DESIGN-TOKENS — ação iniciada por teclado
 * animada parece desconectada e lenta); `null` é o primeiro render.
 */
export type OrigemDaTroca = "ponteiro" | "teclado";

interface EstadoDaNavegacao {
  secaoAtiva: SecaoId;
  /** O painel da seção (a barra secundária) está escondido pelo usuário. */
  painelRecolhido: boolean;
  ultimaTrocaPor: OrigemDaTroca | null;
  irPara: (id: SecaoId, origem?: OrigemDaTroca) => void;
  alternarPainel: () => void;
}

/**
 * A seção que abre numa instalação nova.
 *
 * `notas`, e não `hoje`, por enquanto: é a única seção com conteúdo real
 * hoje, e os testes e2e esperam a árvore de páginas (`[aria-label="Páginas"]`)
 * na abertura. Quando Hoje estiver de pé, trocar esta constante é a mudança
 * inteira — a seção que a pessoa deixou aberta continua sendo lembrada.
 */
export const SECAO_PADRAO: SecaoId = "notas";

/**
 * Onde a posição sobrevive a fechar o app.
 *
 * `localStorage`, e não o `config.json` do backend como o tema: a seção
 * aberta é posição de janela, não preferência — não precisa entrar em backup
 * nem migrar com a pasta de trabalho, e não vale um comando Rust novo e um
 * round-trip de IPC antes do primeiro paint. Se um dia for para o disco, o
 * padrão é o do `theme-store.ts` (cache síncrono + reconciliação).
 */
const CHAVE = "learno:navegacao";

interface Persistido {
  secaoAtiva: SecaoId;
  painelRecolhido: boolean;
}

/**
 * Lê o que ficou salvo. Nunca lança e nunca confia no que leu: um id de uma
 * seção que deixou de existir, ou JSON corrompido, cai no padrão.
 */
export function lerPersistido(): Persistido {
  const padrao: Persistido = { secaoAtiva: SECAO_PADRAO, painelRecolhido: false };
  try {
    const bruto = window.localStorage.getItem(CHAVE);
    if (bruto === null) return padrao;
    const lido: unknown = JSON.parse(bruto);
    if (typeof lido !== "object" || lido === null) return padrao;
    // `in` estreita `object` para o que tem a chave; o valor ainda é `unknown`
    // e passa pela guarda antes de virar `SecaoId` — sem `as`.
    const secaoAtiva = "secaoAtiva" in lido && ehSecaoId(lido.secaoAtiva) ? lido.secaoAtiva : padrao.secaoAtiva;
    const painelRecolhido =
      "painelRecolhido" in lido && typeof lido.painelRecolhido === "boolean" ? lido.painelRecolhido : false;
    return { secaoAtiva, painelRecolhido };
  } catch {
    return padrao;
  }
}

function gravarPersistido(valor: Persistido) {
  try {
    window.localStorage.setItem(CHAVE, JSON.stringify(valor));
  } catch {
    // Storage indisponível: a posição vale nesta sessão e volta ao padrão na
    // próxima. Não é motivo para avisar ninguém.
  }
}

export const useNavegacaoStore = create<EstadoDaNavegacao>((set, get) => {
  const inicial = lerPersistido();

  return {
    secaoAtiva: inicial.secaoAtiva,
    painelRecolhido: inicial.painelRecolhido,
    ultimaTrocaPor: null,

    irPara: (id, origem = "ponteiro") => {
      const { secaoAtiva, painelRecolhido } = get();
      if (secaoAtiva === id) return;
      set({ secaoAtiva: id, ultimaTrocaPor: origem });
      gravarPersistido({ secaoAtiva: id, painelRecolhido });
    },

    alternarPainel: () => {
      const { secaoAtiva, painelRecolhido } = get();
      const proximo = !painelRecolhido;
      set({ painelRecolhido: proximo });
      gravarPersistido({ secaoAtiva, painelRecolhido: proximo });
    },
  };
});
