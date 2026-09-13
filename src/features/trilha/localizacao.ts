/**
 * Onde a trilha ATIVA mora — `containerPageId` (a página que a carrega) e
 * `viewId` (a view do tipo `trail` dentro do database dela).
 *
 * ANTES desta entrega o app só conseguia guardar UMA trilha aqui, e não
 * havia jeito de perguntar ao backend "que trilhas existem?" — só de ler uma
 * já conhecida (`obterTrilha` exige o `viewId`). `listarTrilhas` (ver
 * `lib/ipc.ts`) fechou essa lacuna: a LISTA agora vem do banco toda vez que
 * o painel abre (`store.ts::carregarTrilhas`), nunca daqui. Este arquivo
 * guarda só a ESCOLHA — qual das trilhas listadas é a ativa agora — porque
 * isso é preferência do usuário, não dado; a Trilha em si (páginas,
 * database, etapas, flechas) está toda no SQLite, e `listarTrilhas` já
 * resolveria essa preferência sozinho na ausência de um ponteiro salvo (a
 * primeira da lista), então perder este `localStorage` nunca deixa a seção
 * Trilha vazia com dado órfão no banco — só troca qual trilha abre primeiro.
 */
const CHAVE = "learno:trilha-localizacao";

export interface LocalizacaoDaTrilha {
  containerPageId: string;
  viewId: string;
}

function ehLocalizacaoValida(valor: unknown): valor is LocalizacaoDaTrilha {
  if (typeof valor !== "object" || valor === null) return false;
  // `as` seguro aqui: a linha acima já garantiu objeto não-nulo; isto só
  // amplia o tipo pra sondar `containerPageId`/`viewId` sem afirmar que
  // existem — mesmo padrão de `isAppErrorPayload` em `lib/ipc.ts`.
  const candidato = valor as Record<string, unknown>;
  return typeof candidato.containerPageId === "string" && typeof candidato.viewId === "string";
}

/** Nunca lança: sem `localStorage` (ou bloqueado) só diz que não há Trilha salva. */
export function lerLocalizacaoDaTrilha(): LocalizacaoDaTrilha | null {
  try {
    const bruto = localStorage.getItem(CHAVE);
    if (!bruto) return null;
    const valor: unknown = JSON.parse(bruto);
    return ehLocalizacaoValida(valor) ? valor : null;
  } catch {
    return null;
  }
}

export function salvarLocalizacaoDaTrilha(localizacao: LocalizacaoDaTrilha): void {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(localizacao));
  } catch {
    // Sem storage disponível: a Trilha recém-criada continua funcionando
    // nesta sessão (o `viewId` já está no estado do zustand); só não
    // sobrevive a um recarregar da página.
  }
}

/**
 * Usado quando a trilha apontada é apagada — sem isto, `carregar()` na
 * próxima abertura tentaria `obterTrilha` de uma `view_id` cuja página está
 * na lixeira (a view em si não é apagada por `trashPage`, só a página que a
 * carrega) e o resultado dependeria de sorte: sucesso (view ainda existe,
 * mostrando uma trilha "fantasma" que `listarTrilhas` já escondeu da lista)
 * quando o esperado é cair limpo em "vazia".
 */
export function limparLocalizacaoDaTrilha(): void {
  try {
    localStorage.removeItem(CHAVE);
  } catch {
    // Sem storage disponível: nada para limpar.
  }
}
