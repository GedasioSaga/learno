/**
 * Ponte local para a procedência de um cartão criado a partir de um bloco de
 * página (a primeira origem do briefing desta peça).
 *
 * `NoteRow.sourceBlockId` guarda só o ID do bloco — não a página em que ele
 * mora — e não existe hoje nenhum comando IPC que responda "de que página é
 * este bloco?" (conferido tanto em `src/lib/ipc.ts` quanto em
 * `src-tauri/src/ipc/block_commands.rs` antes de escrever isto: `BlockRow`
 * até TEM `page_id`, mas o único comando que devolve blocos é
 * `list_page_blocks(pageId)` — já exige saber a página para perguntar por
 * ela). Criar esse comando exigiria mexer em `src-tauri/src/lib.rs` e em
 * `src/lib/ipc.ts` — os dois fora do escopo desta peça.
 *
 * A ponte possível sem tocar nenhum dos dois: no exato instante em que o
 * cartão nasce, o editor JÁ SABE em que página está
 * (`pageIdOf(editor)`, `src/features/editor/core/page-context.ts`) — não
 * precisa perguntar a ninguém depois. Guardar esse par aqui, em
 * `localStorage`, é o que deixa a Sessão de Estudo (rodando depois, talvez em
 * outra abertura do app) mostrar "de: <página>" sem round-trip nenhum.
 *
 * Limite conhecido, deliberado — relatado, não escondido:
 *
 * - se o bloco for MOVIDO para outra página depois de o cartão nascer, este
 *   cache fica desatualizado (o link levaria para a página errada). Não há
 *   como perceber isso sem o comando que falta;
 * - um cartão criado antes desta peça existir, ou restaurado de um backup
 *   feito em outra instalação, nunca teve esta entrada gravada.
 *
 * Em qualquer um destes casos `paginaDoBloco` devolve `null`, e
 * `ProcedenciaDoCartao` trata isso como "sem página conhecida" — cai para o
 * texto congelado em vez de inventar (ou manter) um link errado.
 */
const CHAVE_ARMAZENAMENTO = "learno:cartoes:origem-bloco:v1";

function lerMapa(): Record<string, string> {
  try {
    const bruto = localStorage.getItem(CHAVE_ARMAZENAMENTO);
    if (!bruto) return {};
    const parsed: unknown = JSON.parse(bruto);
    if (parsed === null || typeof parsed !== "object") return {};
    // `as` sem checar cada valor: só `gravarMapa` escreve nesta chave, e ela
    // só grava string -> string (`lembrarPaginaDoBloco`). Um valor que não
    // seja string aqui só pode vir de alguém editando `localStorage` na mão
    // (devtools) - nesse caso o pior que acontece é `paginaDoBloco` devolver
    // um `pageId` que não bate com nada em `pagesById` (`ProcedenciaDoCartao`
    // cai no texto congelado), nunca um crash.
    return parsed as Record<string, string>;
  } catch {
    // Storage corrompido ou inacessível (janela privada, cota cheia): trata
    // como "nenhum bloco visto ainda" em vez de quebrar quem chamou.
    return {};
  }
}

function gravarMapa(mapa: Record<string, string>): void {
  try {
    localStorage.setItem(CHAVE_ARMAZENAMENTO, JSON.stringify(mapa));
  } catch {
    // Melhor esforço: sem persistência a sessão atual segue correta, só a
    // Sessão de Estudo de uma abertura futura não vai achar esta página.
  }
}

/** Chamado no instante em que um cartão nasce de um bloco de página — ver o comentário do arquivo. */
export function lembrarPaginaDoBloco(blockId: string, pageId: string): void {
  const mapa = lerMapa();
  mapa[blockId] = pageId;
  gravarMapa(mapa);
}

/** `null` quando este bloco nunca foi visto por `lembrarPaginaDoBloco` nesta instalação. */
export function paginaDoBloco(blockId: string): string | null {
  return lerMapa()[blockId] ?? null;
}
