import { invoke } from "@tauri-apps/api/core";

/**
 * Espelha `AppConfig` em `src-tauri/src/config/mod.rs`. Um campo só, e sem
 * segredo nenhum: depois da migracao para SQLite o banco e um arquivo dentro
 * desta pasta, entao nao existe credencial a guardar nem a redigitar a cada
 * abertura do app.
 */
export interface AppConfig {
  data_dir: string;
}

/** Espelha `ErrorPayload` em `src-tauri/src/error.rs` — a forma de todo erro que cruza o IPC. */
export interface AppErrorPayload {
  kind: string;
  message: string;
}

function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  // `as` seguro aqui: já checamos acima que é um objeto não-nulo; isto só
  // amplia o tipo pra poder sondar `kind`/`message` sem afirmar que eles existem.
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === "string" && typeof candidate.message === "string";
}

/**
 * O que `invoke()` rejeita quando um comando falha. `kind` é estável e pensado
 * pra código ramificar sobre ele; `message` é só pra mostrar ao usuário.
 */
export class AppError extends Error {
  readonly kind: string;

  constructor(payload: AppErrorPayload) {
    super(payload.message);
    this.name = "AppError";
    this.kind = payload.kind;
  }
}

/**
 * Envolve `invoke` para sempre rejeitar com `AppError` — nunca com o valor
 * cru que o backend serializou — assim quem chama nunca precisa checar a
 * forma do erro na mão em mais de um lugar.
 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    if (isAppErrorPayload(error)) {
      throw new AppError(error);
    }
    throw error;
  }
}

/**
 * A pasta de trabalho escolhida, ou `null` se o usuario nunca escolheu uma —
 * caso em que `openWorkspace` usa a pasta padrao do sistema operacional.
 */
export function getAppConfig(): Promise<AppConfig | null> {
  return call<AppConfig | null>("get_app_config");
}

/**
 * Abre o banco e deixa o app pronto para usar. E a primeira chamada do
 * frontend ao subir.
 *
 * Nao recebe nada: com o banco em arquivo local nao ha host, porta, usuario
 * nem senha a coletar, entao a primeira execucao numa maquina qualquer so
 * abre — o assistente de conexao deixou de existir junto com o Postgres.
 * Idempotente: chamar de novo reabre contra a mesma pasta.
 */
export function openWorkspace(): Promise<AppConfig> {
  return call<AppConfig>("open_workspace");
}

/**
 * PLT-016: pasta de trabalho escolhida. `null` quando nada foi salvo ainda —
 * o backend cai para o padrao do SO (`app_data_dir()`) nesse caso.
 */
export function getDataDir(): Promise<string | null> {
  return call<string | null>("get_data_dir");
}

/**
 * PLT-016: troca a pasta de trabalho e reabre o banco la, devolvendo a
 * configuracao que passou a valer. Rejeita string vazia/so espaco.
 *
 * Leva o banco junto quando a pasta nova ainda nao tem um; adota o que ja
 * estiver la quando tem. Nada e apagado da pasta antiga.
 */
export function saveDataDir(dataDir: string): Promise<AppConfig> {
  return call<AppConfig>("save_data_dir", { dataDir });
}

/**
 * O tema escolhido, ou `null` se o usuario nunca escolheu — caso em que vale o
 * tema padrao do produto.
 *
 * O backend nao conhece a lista de temas, so a forma de um id: quem sabe
 * pintar cada um e `src/lib/themes.ts`, e repetir o catalogo em Rust criaria
 * duas fontes da verdade. Um id desconhecido simplesmente nao casa nenhum
 * seletor e cai no padrao.
 */
export function getTheme(): Promise<string | null> {
  return call<string | null>("get_theme");
}

/** Persiste o tema escolhido no mesmo `config.json` das outras configuracoes. */
export function saveTheme(theme: string): Promise<void> {
  return call<void>("save_theme", { theme });
}

/**
 * Espelha `PageRow` em `src-tauri/src/db/pages.rs`. Os nomes de campo ficam em
 * `snake_case` de propósito — `#[derive(Serialize)]` lá não tem `rename_all`,
 * então é isso que chega pelo IPC; um `PageRow` "afrancesado" em camelCase
 * pareceria mais idiomático em TS, mas divergiria do que a rede realmente
 * manda, que é o único ponto desta convenção "espelha X" no resto do arquivo.
 */
export interface PageRow {
  id: string;
  parent_id: string | null;
  database_id: string | null;
  title: string;
  icon: string | null;
  position: string;
  is_favorite: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Espelha `SiblingPosition` em `src-tauri/src/db/pages.rs` — mesma forma
 * "adjacently tagged" (`{ type, value }`) que o `#[derive(Deserialize)]` de
 * lá declara.
 */
export type SiblingPosition =
  | { type: "start" }
  | { type: "end" }
  | { type: "after"; value: string };

/** FUN-001: toda a árvore de páginas ativas, plana — o chamador agrupa por `parent_id`. */
export function listPageTree(): Promise<PageRow[]> {
  return call<PageRow[]>("list_page_tree");
}

/**
 * FUN-002: cria uma página em branco (título vazio se `title` não vier) como
 * última filha de `parentId` (raiz quando `null`).
 */
export function createPage(parentId: string | null, title?: string): Promise<PageRow> {
  return call<PageRow>("create_page", { parentId, title: title ?? null });
}

export function renamePage(id: string, title: string): Promise<PageRow> {
  return call<PageRow>("rename_page", { id, title });
}

/** FUN-008/FUN-009. */
export function setPageFavorite(id: string, isFavorite: boolean): Promise<PageRow> {
  return call<PageRow>("set_page_favorite", { id, isFavorite });
}

/** FUN-011. `icon: null` remove o emoji e volta ao ícone padrão do livro. */
export function setPageIcon(id: string, icon: string | null): Promise<PageRow> {
  return call<PageRow>("set_page_icon", { id, icon });
}

/** FUN-004/FUN-005/FUN-006/FUN-022: reparenteia e/ou reordena `id`. */
export function movePage(
  id: string,
  newParentId: string | null,
  target: SiblingPosition,
): Promise<PageRow> {
  return call<PageRow>("move_page", { id, newParentId, target });
}

/** FUN-020. Só a nova raiz volta — o chamador recarrega a árvore para ver as novas filhas. */
export function duplicatePage(id: string): Promise<PageRow> {
  return call<PageRow>("duplicate_page", { id });
}

/**
 * FUN-027: move a página para a lixeira (marca `deleted_at`, nunca apaga a
 * linha). Ela some da árvore/busca ativa e passa a aparecer só em
 * `listTrashedPages`.
 */
export function trashPage(id: string): Promise<PageRow> {
  return call<PageRow>("trash_page", { id });
}

/**
 * FUN-029/FUN-030: restaura uma página da lixeira. Volta como filha do pai
 * original quando ele ainda está ativo; cai na raiz quando o pai sumiu ou
 * também está na lixeira — decisão já tomada no backend
 * (`PageRepository::restore`), este wrapper só expõe o resultado.
 */
export function restorePage(id: string): Promise<PageRow> {
  return call<PageRow>("restore_page", { id });
}

/** FUN-031: remove definitivamente uma página que já está na lixeira. Irreversível. */
export function permanentlyDeletePage(id: string): Promise<void> {
  return call<void>("permanently_delete_page", { id });
}

/** Alimenta a tela da Lixeira: toda página com `deleted_at` preenchido. */
export function listTrashedPages(): Promise<PageRow[]> {
  return call<PageRow[]>("list_trashed_pages");
}

/** FUN-019: a própria página mais cada ancestral, da raiz até ela. */
export function getPageBreadcrumb(id: string): Promise<PageRow[]> {
  return call<PageRow[]>("get_page_breadcrumb", { id });
}

/**
 * Espelha `PageVersionRow` em `src-tauri/src/db/page_versions.rs` — mesma
 * convenção `snake_case` de `PageRow` acima (sem `rename_all` do lado Rust).
 */
export type SnapshotReason = "autosave" | "manual" | "restore";

export interface PageVersion {
  id: string;
  page_id: string;
  title: string;
  content: unknown;
  reason: SnapshotReason;
  created_at: string;
}

/** FUN-035: histórico de uma página, do snapshot mais recente ao mais antigo. */
export function listPageVersions(pageId: string): Promise<PageVersion[]> {
  return call<PageVersion[]>("list_page_versions", { pageId });
}

/**
 * FUN-036: torna `versionId` o conteúdo atual da página. O backend sempre
 * grava um novo snapshot de restauração — nada da história anterior,
 * incluindo a versão restaurada, é apagado.
 */
export function restorePageVersion(pageId: string, versionId: string): Promise<PageVersion> {
  return call<PageVersion>("restore_page_version", { pageId, versionId });
}

/**
 * FUN-034: congela o título/conteúdo atual como um snapshot de autosave.
 * Chamado pelo temporizador periódico de `PageWorkspace` — nunca pelo
 * usuário diretamente, por isso não existe uma versão "manual" aqui: o
 * backend sempre grava com `reason: "autosave"`.
 */
export function createPageVersionSnapshot(
  pageId: string,
  title: string,
  content: unknown,
): Promise<PageVersion> {
  return call<PageVersion>("create_page_version_snapshot", { pageId, title, content });
}

/** Espelha `SearchResultRow` em `src-tauri/src/db/search.rs`. */
export type SearchMatchKind = "title" | "content";

export interface SearchResult {
  page_id: string;
  page_title: string;
  snippet: string;
  match_kind: SearchMatchKind;
  rank: number;
}

/**
 * FUN-037: busca global por título de página e conteúdo de bloco, acentos e
 * caixa ignorados pelo backend. Uma `query` vazia/só espaços resolve para
 * `[]` sem round-trip — ver o guard equivalente em `SearchRepository::search`.
 */
export function searchPages(query: string): Promise<SearchResult[]> {
  return call<SearchResult[]>("search_pages", { query });
}

// ---- Backlinks (FUN-044/FUN-045) -----------------------------------------
//
// Consolidado aqui a partir de `features/pages/backlinks/ipc.ts` pela mesma
// razão documentada nas seções Gamificação e Prazos abaixo: aquele arquivo
// nasceu fora deste porque a peça que o escreveu não estava autorizada a
// editar `src/lib/ipc.ts` na rodada dela, com sua própria cópia de
// `call`/`isAppErrorPayload` — e por isso nunca entrava na comparação de
// `contrato-ipc.test.ts`. Agora `features/pages/backlinks/ipc.ts` só
// reexporta o que está aqui.

/** Espelha `db::backlinks::BacklinkRow`. */
export interface BacklinkRow {
  sourceBlockId: string;
  sourcePageId: string;
  sourcePageTitle: string;
  /** Trecho do bloco de origem, já cortado no servidor (ver `SNIPPET_MAX_CHARS` em `db::backlinks`). */
  sourceSnippet: string;
  targetPageId: string;
}

/** Espelha `db::backlinks::OutgoingLinkRow` — a direção inversa, não usada pelo rodapé de FUN-044, mas parte do mesmo par de comandos. */
export interface OutgoingLinkRow {
  sourceBlockId: string;
  targetPageId: string;
  targetPageTitle: string;
}

/** FUN-044: todo bloco, em qualquer página ativa, que menciona ou linka `pageId`. */
export function listBacklinks(pageId: string): Promise<BacklinkRow[]> {
  return call<BacklinkRow[]>("list_backlinks", { pageId });
}

/** O que `pageId` linka — espelhado por completude do wrapper, não consumido pelo rodapé de backlinks. */
export function listOutgoingLinks(pageId: string): Promise<OutgoingLinkRow[]> {
  return call<OutgoingLinkRow[]>("list_outgoing_links", { pageId });
}

/**
 * Espelha `backup::autosave::JournalEntry` em `src-tauri/src/backup/autosave.rs`
 * — o rascunho não salvo de uma página, gravado em disco fora do Postgres.
 */
export interface AutosaveJournalEntry {
  page_id: string;
  title: string;
  content: unknown;
  captured_at: string;
}

/**
 * PLT-005: grava (ou substitui) o rascunho não salvo de uma página. Chamar a
 * cada poucos segundos de digitação — bem mais frequente que o snapshot de
 * versão de 10 minutos do FUN-034 (`listPageVersions`), porque este é o que
 * sobrevive a uma queda do processo entre um snapshot e outro.
 */
export function autosaveWritePending(pageId: string, title: string, content: unknown): Promise<void> {
  return call<void>("autosave_write_pending", { pageId, title, content });
}

/** PLT-005: chamar depois que o conteúdo já está de fato salvo no Postgres. */
export function autosaveClearPending(pageId: string): Promise<void> {
  return call<void>("autosave_clear_pending", { pageId });
}

/**
 * PLT-005: chamar na inicialização do app. Qualquer entrada aqui existe só
 * porque a sessão anterior terminou sem confirmar que aquele conteúdo
 * chegou ao banco.
 */
export function autosaveListRecoverable(): Promise<AutosaveJournalEntry[]> {
  return call<AutosaveJournalEntry[]>("autosave_list_recoverable");
}

/**
 * PLT-005 (fusão ao reabrir): compara o rascunho recuperado com o último
 * snapshot confirmado da página. `null` quando o rascunho é mais velho que
 * esse snapshot e não deve ser oferecido ao usuário.
 */
export function autosaveMergeWithSaved(entry: AutosaveJournalEntry): Promise<AutosaveJournalEntry | null> {
  return call<AutosaveJournalEntry | null>("autosave_merge_with_saved", { entry });
}

/**
 * PLT-011: escreve uma copia completa do banco na pasta escolhida, por
 * `VACUUM INTO` — uma instrucao SQL na propria conexao, sem processo externo
 * e sem credencial. Devolve o caminho do arquivo criado.
 */
export function createBackup(outputDir: string): Promise<string> {
  return call<string>("create_backup", { outputDir });
}

/**
 * PLT-011: restaura um backup gerado por `createBackup` sobre o banco atual.
 * O arquivo e verificado antes de qualquer substituicao, e o banco que ele
 * substitui fica copiado ao lado. Ao terminar, o app ja esta conectado ao
 * banco restaurado.
 */
export function restoreBackup(dumpPath: string): Promise<void> {
  return call<void>("restore_backup", { dumpPath });
}

/** FUN-023: converte a página (título + árvore de blocos ativa) para Markdown e grava no caminho escolhido pelo usuário. */
export function exportPageMarkdown(pageId: string, targetPath: string): Promise<void> {
  return call<void>("export_page_markdown", { pageId, targetPath });
}

/** FUN-023: nome de arquivo sugerido no diálogo de salvar, já livre de caractere inválido no Windows. */
export function defaultExportFileName(title: string): Promise<string> {
  return call<string>("default_export_file_name", { title });
}

/** Espelha `backup::schedule::Cadence` em `src-tauri/src/backup/schedule.rs`. */
export type BackupCadence = "daily" | "weekly" | "monthly";

/**
 * Espelha `backup::schedule::ScheduleConfig` em `src-tauri/src/backup/schedule.rs`
 * — configuração do backup automático periódico (PLT-013), distinto do
 * backup manual sob comando (`createBackup`, PLT-011).
 */
export interface BackupScheduleConfig {
  enabled: boolean;
  cadence: BackupCadence;
  keep_scheduled: number;
  keep_risky_operation: number;
}

/** PLT-013: lê a configuração de backup automático salva, ou o padrão (desativado). */
export function getBackupScheduleConfig(): Promise<BackupScheduleConfig> {
  return call<BackupScheduleConfig>("get_backup_schedule_config");
}

/** PLT-013: grava a configuração de backup automático. */
export function saveBackupScheduleConfig(config: BackupScheduleConfig): Promise<void> {
  return call<void>("save_backup_schedule_config", { config });
}

/**
 * PLT-013: dispara a checagem "está na hora de rodar o backup automático?"
 * contra a cadência configurada. `null` quando o backup automático está
 * desativado ou o intervalo ainda não decorreu — nenhum arquivo é criado
 * nesse caso.
 */
export function runDueScheduledBackup(): Promise<string | null> {
  return call<string | null>("run_due_scheduled_backup");
}

/**
 * PLT-013: cria um backup automático imediatamente, marcado como disparado
 * por uma operação de risco (`operation` é um rótulo livre, ex.:
 * `"import_colpkg"`) — independente da cadência configurada, e prunado pela
 * sua própria retenção.
 */
export function triggerBackupForRiskyOperation(operation: string): Promise<string> {
  return call<string>("trigger_backup_for_risky_operation", { operation });
}

/**
 * Espelha `db::integrity::IntegrityReport` em `src-tauri/src/db/integrity.rs`.
 * `orphaned_card_ids` é a lista de cartões removidos por não pertencerem a
 * nenhuma nota — a UI usa o tamanho dela (não só `total_repaired`) para dizer
 * ao usuário exatamente o que sumiu, não só quantos problemas havia.
 */
export interface IntegrityReport {
  orphaned_card_ids: string[];
  total_repaired: number;
}

/**
 * PLT-014: "Check Database" — vasculha a coleção local em busca de linhas que
 * violam a integridade referencial do próprio schema mas escaparam das
 * constraints (import de baralho fora de ordem, restauração de um backup
 * antigo, edição direta do banco) e conserta na hora. Nunca falha só por não
 * achar nada: `total_repaired: 0` é um resultado válido, não um erro — a
 * mesma distinção que `checkStatus`/`summarize` em `CheckDatabaseSection`
 * fazem visível ao usuário.
 *
 * PLT-013: "Check Database" é um dos dois gatilhos de operação de risco que
 * já têm código real por trás (o reparo apaga linha), entao o backend faz uma
 * copia de seguranca antes de reparar. Se esse backup falhar (disco cheio,
 * permissao negada na pasta), o reparo nem chega a rodar — o erro que volta
 * aqui já descreve o motivo.
 */
export function checkDatabase(): Promise<IntegrityReport> {
  return call<IntegrityReport>("check_database");
}

/**
 * Espelha `ApkgImportResult` em `src-tauri/src/ipc/commands.rs`. Nesta fase
 * (PLT-004) o sidecar Python só valida o `.apkg` como zip e responde — ler
 * as notas de dentro dele de verdade é Fase 4 — por isso `notes_imported`
 * sempre chega `0` por enquanto. O tipo já espelha o formato final para não
 * precisar mudar nada aqui quando a leitura real for implementada.
 */
export interface ApkgImportResult {
  notes_imported: number;
}

/**
 * PLT-004: envia `path` (de um `.apkg` já escolhido pelo usuário via
 * `@tauri-apps/plugin-dialog`) ao sidecar Python e espera o resultado.
 * Rejeita com `AppError` de `kind: "invalid"` (caminho vazio) ou
 * `kind: "sidecar"` (sidecar não encontrado, não respondeu a tempo, ou
 * morreu no meio) — nunca uma exceção não tratada, conforme o critério de
 * aceite de PLT-004.
 *
 * PLT-013: import de baralho é o outro gatilho de operação de risco com
 * código real por trás — um import pode sobrescrever cartões existentes, entao
 * o backend faz uma copia de seguranca antes de chamar o sidecar. Um backup
 * que falhar aborta o import inteiro, e o erro chega aqui igual a qualquer
 * outro erro deste módulo.
 */
export function importApkg(path: string): Promise<ApkgImportResult> {
  return call<ApkgImportResult>("import_apkg", { path });
}

/**
 * Nome do evento que o item "Alternar tema" do menu nativo emite — tem que
 * ser exatamente igual à constante `TOGGLE_THEME_EVENT` em `src-tauri/src/lib.rs`.
 */
export const TOGGLE_THEME_EVENT = "learno://toggle-theme";

/* =========================================================================
 * Fase 5 — Cartões, Mapa mental e Pomodoro.
 *
 * Contrato fixado pelo orquestrador em 05/09/2026; o backend Rust está
 * sendo escrito contra ele em paralelo. Tudo aqui é `camelCase`, que é o
 * que `#[serde(rename_all = "camelCase")]` já manda para todo struct da
 * Fase 2+ (`db::decks::DeckRow`, `db::blocks::BlockRow`) — `PageRow` acima é
 * a exceção da Fase 1.
 *
 * Os campos de cada linha espelham as colunas de `src-tauri/migrations/`
 * (0010 decks/note_types, 0011 notes/cards, 0013 mindmap, 0014 pomodoro).
 * O que o contrato NÃO fixou e foi decidido aqui está marcado com
 * "decisão deste arquivo" — conferir contra o Rust quando ele fechar.
 * ========================================================================= */

// ---- Cartões (repetição espaçada) --------------------------------------

/** Espelha `DeckRow` em `src-tauri/src/db/decks.rs`. `parentId` faz a árvore. */
export interface DeckRow {
  id: string;
  parentId: string | null;
  name: string;
  /** Preset de agendamento, JSON livre (`decks.options`). A UI não interpreta. */
  options: unknown;
  position: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `decks.options.agendador`: qual agendador um cartão NOVO deste baralho recebe ao nascer. */
export type AgendadorDeBaralho = "sm2" | "fsrs";

/**
 * Espelha `OpcoesDeDeckJson` em `src-tauri/src/db/cards.rs` — a configuração
 * de agendamento de um baralho, já normalizada (defaults aplicados).
 *
 * EXCEÇÃO DELIBERADA À CONVENÇÃO: os campos viajam em `snake_case`, não em
 * `camelCase` como `DeckRow`/`CardRow`. A struct Rust não tem
 * `#[serde(rename_all = "camelCase")]` porque é o MESMO tipo que lê e grava
 * `decks.options` no banco: renomear no serde mudaria o formato gravado, e
 * todo `options` já existente (em snake_case) deixaria de ser lido — cairia
 * em silêncio no default, que é o modo de falha que `parse_opcoes_de_deck`
 * foi feito para tolerar, não para provocar. Declarar `snake_case` aqui é o
 * lado barato e seguro; `contrato-ipc.test.ts` confere campo a campo.
 * Precedente no mesmo arquivo: `AppConfig.data_dir`.
 */
export interface OpcoesDeDeckJson {
  /** Minutos de cada passo de aprendizagem; vazio gradua na primeira resposta. */
  learning_steps_min: number[];
  relearning_steps_min: number[];
  graduating_interval_dias: number;
  easy_interval_dias: number;
  /** Escala ×100: 130 = intervalo × 1,3. */
  easy_bonus_pct: number;
  hard_interval_pct: number;
  /** 0–100: fração do intervalo anterior que sobra depois de um lapso. */
  lapse_new_interval_percent: number;
  minimum_interval_dias: number;
  maximum_interval_dias: number;
  /** 0 desliga a detecção de leech. */
  leech_threshold: number;
  fuzz_habilitado: boolean;
  agendador: AgendadorDeBaralho;
  /** 0–1 (0.9 = 90 %). Só faz efeito sob FSRS. */
  fsrs_retencao_desejada: number;
  /** Exatamente 21 números (FSRS-6); o serde do Rust recusa outro tamanho. */
  fsrs_pesos: number[];
}

/** O que o rail de baralhos mostra por linha. Nomes em português por decisão do contrato. */
export interface DeckCounts {
  novos: number;
  aprendendo: number;
  revisar: number;
}

/**
 * Espelha `DeckMaturity` em `src-tauri/src/db/cards.rs` — quanto de UM
 * baralho específico (`deckId` exato, sem descer para subbaralhos) já foi de
 * fato APRENDIDO, não só "quantos cartões tem" (`DeckCounts` acima) nem
 * "quanto falta estudar hoje". A Trilha usa isto para mostrar, no material de
 * baralho de uma etapa, o quanto aquele baralho já foi memorizado de verdade.
 *
 * `maduros + jovens + novos + suspensos` pode ser MENOR que `total`: um
 * cartão em `learning` (primeira aprendizagem, nunca chegou a `review`) não
 * cai em nenhum dos quatro — decisão deliberada, ver o comentário completo em
 * `db::DeckMaturity` no Rust. `fracaoMaduros` já vem calculada pelo backend e
 * nunca é `NaN` (denominador zero — baralho vazio ou 100% suspenso — vira
 * `0.0` lá), então a tela nunca precisa dividir isto sozinha.
 */
export interface DeckMaturity {
  total: number;
  maduros: number;
  jovens: number;
  novos: number;
  suspensos: number;
  fracaoMaduros: number;
}

/** Coluna `cards.state` (0011). */
export type CardState = "new" | "learning" | "review" | "relearning" | "suspended";

export type CardScheduler = "sm2" | "fsrs";

/** Os quatro botões de resposta, na ordem do teclado (1–4). */
export type CardRating = "again" | "hard" | "good" | "easy";

/** Espelha as colunas de `cards` (0011). */
export interface CardRow {
  id: string;
  noteId: string;
  deckId: string;
  templateOrdinal: number;
  state: CardState;
  due: string | null;
  scheduler: CardScheduler;
  intervalDays: number;
  /** SM-2, inteiro ×100 (2500 = 2.50). */
  easeFactor: number;
  fsrsStability: number | null;
  fsrsDifficulty: number | null;
  /**
   * Instante da última revisão FSRS (`0039_cards_fsrs_last_review_at.sql`), a
   * base de `elapsed_days` em toda fórmula de retenção do FSRS.
   *
   * Coluna dedicada de propósito, e não `updatedAt`: o trigger
   * `cards_set_updated_at` dispara em QUALQUER `UPDATE` na tabela, não só numa
   * revisão, então derivar daí faria a estabilidade sair errada em silêncio no
   * dia em que "enterrar cartão" (ou qualquer outra escrita) tocasse a linha.
   *
   * `null` em cartão SM-2 e em cartão FSRS ainda não respondido — os três
   * campos de memória (`fsrsStability`, `fsrsDifficulty` e este) só valem
   * juntos; o Rust só reconstrói a memória quando os três estão presentes.
   */
  fsrsLastReviewAt: string | null;
  learningStep: number;
  lapses: number;
  reps: number;
  isLeech: boolean;
  flags: number;
  suspendedAt: string | null;
  buriedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `{"Frente": "...", "Verso": "..."}`, chaveado por `NoteTypeRow.fields`. */
export type NoteFieldValues = Record<string, string>;

/** Espelha as colunas de `notes` (0011). */
export interface NoteRow {
  id: string;
  noteTypeId: string;
  deckId: string;
  fieldValues: NoteFieldValues;
  tags: string[];
  sourceBlockId: string | null;
  sourceTextFrozen: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Um template de `note_types.templates` — a mesma forma do Anki. */
export interface NoteTypeTemplate {
  name: string;
  front: string;
  back: string;
}

/** Espelha as colunas de `note_types` (0010). */
export interface NoteTypeRow {
  id: string;
  name: string;
  /** Nomes dos campos, na ordem de exibição. */
  fields: string[];
  templates: NoteTypeTemplate[];
  /**
   * `note_types.kind` (migração `0040`): `"standard"` ou `"cloze"`.
   *
   * Existe porque cloze bifurca o **comportamento de escrita**, não só a
   * aparência: um tipo `cloze` gera um cartão por número de lacuna encontrado
   * no texto, e regenera esse conjunto quando a nota é editada — enquanto um
   * tipo `standard` gera um cartão por entrada de `templates`, na criação, e
   * nunca mais.
   *
   * É uma coluna e não uma comparação por nome de propósito. Os três tipos
   * antigos (Básico, Digitar a resposta, Múltipla escolha) são distinguidos
   * pelo nome só para SEMEAR; amarrar comportamento de escrita ao rótulo de
   * exibição quebraria em silêncio no dia em que renomear tipo de nota
   * existir. O próprio Anki guarda isso em `notetypes.config.kind`.
   */
  kind: "standard" | "cloze";
  createdAt: string;
  updatedAt: string;
}

/** O próximo cartão a estudar, com tudo que a tela precisa para desenhá-lo. */
export interface CardToStudy {
  card: CardRow;
  note: NoteRow;
  /**
   * Os campos já resolvidos para este cartão, chaveados pelo NOME do campo.
   *
   * Este par (`fields` + `fieldNames`) existe porque a costura entre Rust e TS
   * já quebrou aqui uma vez, do jeito mais silencioso possível: o Rust
   * serializava um `Vec<String>` (valores na ordem do tipo de nota) e o TS
   * declarava `Record<string, string>`. Nada falhava — `fields["Frente"]` num
   * array simplesmente devolve `undefined`, e a tela de estudo mostrava
   * "(sem conteúdo)" com o cartão gravado e íntegro no banco. O vitest não
   * pegou porque mocka `ipc.ts` e nunca atravessa o fio.
   *
   * O mapa dá o acesso por nome; `fieldNames` devolve a ordem que o mapa
   * perde. Os dois vêm do mesmo lugar no Rust, então não podem discordar.
   */
  fields: NoteFieldValues;
  /** Nomes dos campos na ordem de `note_types.fields` — `fieldNames[0]` é a frente. */
  fieldNames: string[];
  deckName: string;
  /**
   * `null` para todo tipo padrão; para um tipo cloze (`NoteTypeRow.kind ===
   * "cloze"`), o primeiro campo já quebrado em segmentos para a lacuna DESTE
   * cartão — espelha `CardToStudy.cloze` em `src-tauri/src/db/cards.rs`.
   *
   * O parser de `{{cN::texto::dica}}` mora só no Rust (`db::cloze`), de
   * propósito: a tela nunca interpreta a marcação, só percorre esta lista.
   * A decisão inteira está no comentário de módulo de `db::cloze` ("Uma
   * gramática só").
   */
  cloze: ClozeSegment[] | null;
}

/**
 * Um trecho do texto de um cartão cloze, já resolvido — espelha
 * `ClozeSegment` em `src-tauri/src/db/cloze.rs`.
 *
 * `hidden: true` é a lacuna deste cartão: `text` é a resposta (só entra no
 * DOM depois de revelar) e `hint` o que aparece no lugar dela antes disso
 * (`null` → reticências). `hidden: false` é texto visível desde a frente,
 * literal ou lacuna de outro número já com o conteúdo dela. Concatenar
 * `text` de todos, na ordem, dá o verso completo.
 */
export interface ClozeSegment {
  text: string;
  hidden: boolean;
  hint: string | null;
}

/**
 * O que volta depois de responder — espelha `AnswerOutcome` em
 * `src-tauri/src/db/cards.rs`.
 *
 * É o reagendamento, não o cartão: a tela já passou para o próximo cartão
 * quando isto chega, e o que ela precisa mostrar é quando o que acabou de ser
 * respondido volta ("daqui a 10 minutos", "daqui a 3 dias").
 */
export interface AnswerOutcome {
  proximaRevisao: string;
  intervaloDias: number;
  estado: CardState;
}

/**
 * Um dia da previsão de revisões — espelha `DiaPrevisto` em
 * `src-tauri/src/db/cards.rs`. `data` é `YYYY-MM-DD` no calendário LOCAL, não
 * UTC: a pergunta "quantos cartões vencem quinta" é local por natureza, e um
 * cartão que vence às 23h de quarta em São Paulo vence quinta em UTC.
 */
export interface DeckForecastDay {
  data: string;
  quantidade: number;
}

/**
 * Um dia do histórico de revisões — a célula do mapa de calor.
 *
 * `dia` é `YYYY-MM-DD` no calendário LOCAL, pela mesma razão de
 * `DeckForecastDay.data`: "quanto estudei terça" é uma pergunta local.
 * Dias sem revisão NÃO vêm na lista; quem desenha o calendário preenche os
 * buracos, porque só a tela sabe qual janela quer mostrar.
 */
export interface RevisaoDoDia {
  dia: string;
  revisoes: number;
  /** Tempo somado no dia, em segundos (de `review_log.duration_ms`). */
  segundos: number;
}

/**
 * O que a tela de Estatísticas de cartões desenha — espelha `StudyStats` em
 * `src-tauri/src/db/review_log.rs`.
 *
 * Tudo aqui é derivado de `review_log` (migração 0012), a tabela que registra
 * cada resposta. `retencao` é a fração de respostas "Bom" ou "Fácil"
 * (`rating >= 3`) entre revisões de cartões que já estavam em revisão — é a
 * definição de True Retention do Anki, e não faz sentido para cartão novo,
 * por isso pode vir `null` quando não há revisão madura na janela.
 */
export interface EstatisticasDeEstudo {
  porDia: RevisaoDoDia[];
  totalRevisoes: number;
  /** Média por dia ESTUDADO, não por dia da janela — zero não puxa a média para baixo. */
  mediaDiaria: number;
  diasEstudados: number;
  maiorSequencia: number;
  sequenciaAtual: number;
  retencao: number | null;
}

/** Toda a árvore de baralhos ativos, plana — o chamador agrupa por `parentId`. */
export function listDecks(): Promise<DeckRow[]> {
  return call<DeckRow[]>("list_decks");
}

/** Cria um baralho como último filho de `parentId` (raiz quando ausente). */
export function createDeck(name: string, parentId?: string | null): Promise<DeckRow> {
  return call<DeckRow>("create_deck", { name, parentId: parentId ?? null });
}

export function renameDeck(deckId: string, name: string): Promise<DeckRow> {
  return call<DeckRow>("rename_deck", { deckId, name });
}

export function deleteDeck(deckId: string): Promise<void> {
  return call<void>("delete_deck", { deckId });
}

/** A configuração de agendamento do baralho, já com defaults aplicados — nunca o JSON cru de `decks.options`. */
export function getDeckSchedulingOptions(deckId: string): Promise<OpcoesDeDeckJson> {
  return call<OpcoesDeDeckJson>("get_deck_scheduling_options", { deckId });
}

/**
 * Grava a configuração inteira, inclusive a troca de agendador. NÃO migra
 * cartão existente: só cartão criado depois nasce no agendador novo (decisão
 * documentada em `db::cards::CardRepository::answer_card`).
 */
export function setDeckSchedulingOptions(deckId: string, opcoes: OpcoesDeDeckJson): Promise<DeckRow> {
  return call<DeckRow>("set_deck_scheduling_options", { deckId, opcoes });
}

/** Contadores de hoje; sem `deckId`, da coleção inteira. */
export function deckCounts(deckId?: string | null): Promise<DeckCounts> {
  return call<DeckCounts>("deck_counts", { deckId: deckId ?? null });
}

/**
 * Quanto do baralho `deckId` (exato, sem subbaralhos) já foi de fato
 * aprendido — ver o comentário de `DeckMaturity` acima. Rejeita com
 * `AppError` de `kind: "not_found"` se o baralho não existir (mesma
 * convenção de `Error::NotFound` no backend).
 */
export function deckMaturity(deckId: string): Promise<DeckMaturity> {
  return call<DeckMaturity>("deck_maturity", { deckId });
}

/** O próximo cartão da fila de hoje, ou `null` quando não há mais nada a estudar. */
export function nextCard(deckId?: string | null): Promise<CardToStudy | null> {
  return call<CardToStudy | null>("next_card", { deckId: deckId ?? null });
}

export function answerCard(cardId: string, rating: CardRating): Promise<AnswerOutcome> {
  return call<AnswerOutcome>("answer_card", { cardId, rating });
}

export function listNoteTypes(): Promise<NoteTypeRow[]> {
  return call<NoteTypeRow[]>("list_note_types");
}

/** Cria a nota e, no backend, um cartão por template do tipo de nota. */
export function createNote(
  deckId: string,
  noteTypeId: string,
  fieldValues: NoteFieldValues,
  tags: string[],
): Promise<NoteRow> {
  return call<NoteRow>("create_note", { deckId, noteTypeId, fieldValues, tags });
}

/** Decisão deste arquivo: atualiza campos e etiquetas de uma vez, os dois obrigatórios. */
export function updateNote(noteId: string, fieldValues: NoteFieldValues, tags: string[]): Promise<NoteRow> {
  return call<NoteRow>("update_note", { noteId, fieldValues, tags });
}

export function deleteNote(noteId: string): Promise<void> {
  return call<void>("delete_note", { noteId });
}

/** Página de notas para o navegador; sem `deckId`, de todos os baralhos. */
export function listNotes(deckId: string | null | undefined, limit: number, offset: number): Promise<NoteRow[]> {
  return call<NoteRow[]>("list_notes", { deckId: deckId ?? null, limit, offset });
}

/** Quantos cartões vencem em cada um dos próximos `dias` dias. */
export function deckForecast(deckId: string | null | undefined, dias: number): Promise<DeckForecastDay[]> {
  return call<DeckForecastDay[]>("deck_forecast", { deckId: deckId ?? null, dias });
}

/**
 * O histórico de estudo dos últimos `dias` dias, agregado por dia local.
 *
 * Sem `deckId`, soma todos os baralhos. `dias` conta para trás a partir de
 * hoje, incluindo hoje.
 */
export function estudoEstatisticas(
  deckId: string | null | undefined,
  dias: number,
): Promise<EstatisticasDeEstudo> {
  return call<EstatisticasDeEstudo>("study_stats", { deckId: deckId ?? null, dias });
}

// ---- Mapa mental --------------------------------------------------------

/** Espelha as colunas de `mindmaps` (0013). `pageId` é o vínculo opcional com uma página de Notas. */
export interface MindmapRow {
  id: string;
  pageId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Espelha as colunas de `mindmap_nodes` (0013). `positionX/Y` são coordenadas de canvas. */
export interface MindmapNodeRow {
  id: string;
  mindmapId: string;
  label: string;
  positionX: number;
  positionY: number;
  color: string | null;
  shape: string | null;
  icon: string | null;
  /** Nome do arquivo dentro de `media/` (0032) — mesma convenção de
   *  `content.src` do editor de blocos, ver `media-storage.ts`. Nunca um
   *  emoji: isso é `icon`, coluna separada de propósito. */
  image: string | null;
  collapsed: boolean;
  pageRefId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Espelha as colunas de `mindmap_edges` (0013). */
export interface MindmapEdgeRow {
  id: string;
  mindmapId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string | null;
  /** JSON livre (`mindmap_edges.style`). */
  style: unknown;
  createdAt: string;
}

export interface MindmapGraph {
  mindmap: MindmapRow;
  nodes: MindmapNodeRow[];
  edges: MindmapEdgeRow[];
}

/**
 * Uma mudança num lote de `applyMindmapChanges`. Tagged em `kind` com
 * variantes em camelCase, a mesma forma de `db::effects` no Rust.
 *
 * `id` em `createNode`/`createEdge` é decisão deste arquivo: o canvas gera o
 * id no cliente (o `@xyflow/react` precisa de um id antes de o backend
 * responder) e o backend o adota.
 */
export interface MindmapNodeNovo {
  /** Gerado no cliente: o `@xyflow/react` precisa de um id antes de o backend
   *  responder, e o backend adota o que vier. Ausente, o Rust gera. */
  id?: string;
  label?: string;
  positionX: number;
  positionY: number;
  color?: string | null;
  shape?: string | null;
  icon?: string | null;
  image?: string | null;
  collapsed?: boolean;
  pageRefId?: string | null;
}

export interface MindmapNodePatch {
  label?: string | null;
  color?: string | null;
  shape?: string | null;
  icon?: string | null;
  /**
   * Diferente do resto do patch: aqui a AUSÊNCIA da chave (não o valor
   * `undefined` dentro dela) significa "sem mudança", e `null` significa
   * "remover a imagem" — o Rust (`MindmapNodePatchInput::image`,
   * `deserialize_some`) só consegue distinguir os dois porque o JSON de
   * verdade não manda a chave nenhuma no primeiro caso. Nunca escreva
   * `{ image: undefined }` esperando "sem mudança": omita a chave inteira
   * do objeto literal (é isso que `JSON.stringify` faz sozinho quando o
   * valor é `undefined` — a chave simplesmente não aparece).
   */
  image?: string | null;
  collapsed?: boolean | null;
  pageRefId?: string | null;
}

export interface MindmapEdgeNovo {
  id?: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string | null;
  style?: unknown;
}

export type MindmapChange =
  | { kind: "createNode"; node: MindmapNodeNovo }
  | { kind: "updateNode"; id: string; patch: MindmapNodePatch }
  | { kind: "moveNode"; id: string; position: { positionX: number; positionY: number } }
  | { kind: "deleteNode"; id: string }
  | { kind: "createEdge"; edge: MindmapEdgeNovo }
  | { kind: "updateEdge"; id: string; patch: { label?: string | null; style?: unknown } }
  | { kind: "deleteEdge"; id: string };

export function listMindmaps(): Promise<MindmapRow[]> {
  return call<MindmapRow[]>("list_mindmaps");
}

export function createMindmap(name: string, pageId?: string | null): Promise<MindmapRow> {
  return call<MindmapRow>("create_mindmap", { name, pageId: pageId ?? null });
}

export function renameMindmap(mindmapId: string, name: string): Promise<MindmapRow> {
  return call<MindmapRow>("rename_mindmap", { mindmapId, name });
}

export function deleteMindmap(mindmapId: string): Promise<void> {
  return call<void>("delete_mindmap", { mindmapId });
}

export function getMindmap(mindmapId: string): Promise<MindmapGraph> {
  return call<MindmapGraph>("get_mindmap", { mindmapId });
}

/**
 * Aplica um LOTE de mudanças e devolve o grafo inteiro já atualizado.
 * Uma chamada por gesto concluído (soltar o nó, terminar de digitar o
 * rótulo) — nunca uma por quadro de arrasto.
 */
export function applyMindmapChanges(mindmapId: string, changes: MindmapChange[]): Promise<MindmapGraph> {
  return call<MindmapGraph>("apply_mindmap_changes", { mindmapId, changes });
}

// ---- Pomodoro -----------------------------------------------------------

/** Coluna `pomodoro_sessions.kind` (0014). */
export type PomodoroKind = "focus" | "short_break" | "long_break";

/** Espelha as colunas de `pomodoro_sessions` (0014). */
export interface PomodoroSessionRow {
  id: string;
  kind: PomodoroKind;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  completed: boolean;
  createdAt: string;
}

/** O resumo do dia para a seção Hoje. Nomes em português por decisão do contrato. */
export interface PomodoroToday {
  focosCompletos: number;
  segundosFocados: number;
  /** Dias seguidos com pelo menos um foco completo, contando hoje. */
  sequenciaDias: number;
}

/** Abre uma sessão; o temporizador em si roda no frontend. */
export function startPomodoro(kind: PomodoroKind, durationSeconds: number): Promise<PomodoroSessionRow> {
  return call<PomodoroSessionRow>("start_pomodoro", { kind, durationSeconds });
}

/** Fecha a sessão; `completed: false` quando o usuário interrompeu antes do fim. */
export function finishPomodoro(sessionId: string, completed: boolean): Promise<PomodoroSessionRow> {
  return call<PomodoroSessionRow>("finish_pomodoro", { sessionId, completed });
}

export function pomodoroToday(): Promise<PomodoroToday> {
  return call<PomodoroToday>("pomodoro_today");
}

// ---- Cronograma ----------------------------------------------------------
//
// Contrato fixado pelo orquestrador em 05/09/2026 para a seção Cronograma.
// Nomes de campo espelham `src-tauri/src/db/cronograma.rs` (camelCase de
// `#[serde(rename_all = "camelCase")]`) — não traduza para português aqui.

/**
 * O que fazer num bloco planejado. Os valores são os do `CHECK (activity IN
 * (...))` da migração 0024 e do struct Rust — nunca traduza para português
 * aqui, o rótulo em português vive em `ROTULO_DA_ATIVIDADE`
 * (`features/cronograma/format.ts`), separado do valor que atravessa o fio.
 */
export type AtividadeDoBloco = "pomodoro" | "review" | "mindmap" | "reading" | "other";

/** Espelha `BlocoPlanejado` no backend (Fase 5, Cronograma) — nomes de campo iguais aos do Rust, camelCase. */
export interface BlocoPlanejado {
  id: string;
  /** `YYYY-MM-DD`, calendário LOCAL — o dia do estudante, não UTC. */
  localDate: string;
  /** Ordem entre os blocos do mesmo dia — mesma convenção de posição fracionária de `DeckRow.position`. */
  position: string;
  /** `HH:MM`, ou `null` — `criarBloco` não recebe horário, então o bloco nasce sem um até o backend/uma edição posterior o preencher. */
  startLocalTime: string | null;
  plannedMinutes: number;
  activity: AtividadeDoBloco;
  /** Só populado quando `activity === "pomodoro"`; `criarBloco` não o recebe, viria de um `atualizarBloco` posterior. */
  pomodoroCycles: number | null;
  title: string | null;
  deckId: string | null;
  pageId: string | null;
  /** A matéria do bloco. Só o id atravessa o fio; nome e cor vêm de `listarMaterias()` uma vez, e a tela resolve localmente. */
  subjectId: string | null;
  createdAt: string;
  updatedAt: string;
  /** DERIVADO no Rust a cada leitura, nunca é coluna: `startLocalTime` mais `plannedMinutes`. `null` quando não há horário de início. */
  endLocalTime: string | null;
  /** DERIVADO junto com `endLocalTime`: `true` quando o bloco atravessa a meia-noite (23:30 + 90 min). Sempre `false` quando `endLocalTime` é `null`. */
  crossesMidnight: boolean;
}

/** Um dia da semana planejada: os blocos daquele dia e o que já foi realizado — este último vem do Pomodoro, nunca de digitação. */
export interface DiaDaSemana {
  data: string;
  blocos: BlocoPlanejado[];
  minutosRealizados: number;
}

/** Espelha `SemanaDeEstudo` no backend. `inicio` é sempre a segunda-feira, `YYYY-MM-DD` LOCAL. */
export interface SemanaDeEstudo {
  inicio: string;
  metaMinutos: number;
  dias: DiaDaSemana[];
}

/** Carrega a semana que começa em `inicioDaSemana` (segunda-feira, `YYYY-MM-DD` local — ver `features/cronograma/date-utils.ts`). */
export function semanaDeEstudo(inicioDaSemana: string): Promise<SemanaDeEstudo> {
  return call<SemanaDeEstudo>("semana_de_estudo", { inicioDaSemana });
}

/** Define a meta de minutos de estudo daquela semana. */
export function definirMetaSemanal(inicioDaSemana: string, metaMinutos: number): Promise<void> {
  return call<void>("definir_meta_semanal", { inicioDaSemana, metaMinutos });
}

/** Cria um bloco planejado no dia `dia` (`YYYY-MM-DD` local); horário e posição dentro do dia ficam a cargo do backend. */
export function criarBloco(
  dia: string,
  atividade: AtividadeDoBloco,
  minutosPlanejados: number,
  titulo?: string | null,
  deckId?: string | null,
  pageId?: string | null,
  subjectId?: string | null,
): Promise<BlocoPlanejado> {
  return call<BlocoPlanejado>("criar_bloco", {
    dia,
    atividade,
    minutosPlanejados,
    titulo: titulo ?? null,
    deckId: deckId ?? null,
    pageId: pageId ?? null,
    subjectId: subjectId ?? null,
  });
}

/** Move um bloco para `novoDia`, opcionalmente logo depois de `aposBlocoId` (fim do dia quando ausente) — o gesto de arrastar. */
export function moverBloco(blocoId: string, novoDia: string, aposBlocoId?: string | null): Promise<BlocoPlanejado> {
  return call<BlocoPlanejado>("mover_bloco", { blocoId, novoDia, aposBlocoId: aposBlocoId ?? null });
}

/** Patch parcial de um bloco — só os campos presentes mudam. Espelha `BlocoPatchInput` no backend. */
export interface PatchDeBloco {
  startLocalTime?: string;
  plannedMinutes?: number;
  activity?: AtividadeDoBloco;
  pomodoroCycles?: number | null;
  title?: string | null;
  deckId?: string | null;
  pageId?: string | null;
  subjectId?: string | null;
}

export function atualizarBloco(blocoId: string, patch: PatchDeBloco): Promise<BlocoPlanejado> {
  return call<BlocoPlanejado>("atualizar_bloco", { blocoId, patch });
}

export function removerBloco(blocoId: string): Promise<void> {
  return call<void>("remover_bloco", { blocoId });
}

/** As oito cores válidas de matéria. Cópia da mesma lista no Rust (`VALID_SUBJECT_COLORS`, `db/cronograma.rs`) — não há um lugar só compartilhado entre os dois lados, então as duas mudam juntas. */
export type CorDeMateria = "amber" | "mint" | "azul" | "terracotta" | "roxo" | "emerald" | "vermelho" | "brown";

/** Uma matéria do cronograma. `BlocoPlanejado` carrega só o `subjectId`; a tela resolve nome e cor por esta lista, buscada uma vez. */
export interface Materia {
  id: string;
  name: string;
  color: CorDeMateria;
  createdAt: string;
  updatedAt: string;
}

/** Cor ausente vira a primeira da paleta no backend — não é "sem cor". */
export function criarMateria(nome: string, cor?: CorDeMateria | null): Promise<Materia> {
  return call<Materia>("criar_materia", { nome, cor: cor ?? null });
}

export function listarMaterias(): Promise<Materia[]> {
  return call<Materia[]>("listar_materias");
}

/** Patch parcial — campo ausente é "sem mudança", não "apague". Espelha `MateriaPatchInput` no backend. */
export interface PatchDeMateria {
  name?: string;
  color?: CorDeMateria;
}

export function atualizarMateria(materiaId: string, patch: PatchDeMateria): Promise<Materia> {
  return call<Materia>("atualizar_materia", { materiaId, patch });
}

export function removerMateria(materiaId: string): Promise<void> {
  return call<void>("remover_materia", { materiaId });
}

/** A "semana modelo": duplica os blocos planejados de uma semana para outra. NÃO é idempotente (chamar duas vezes duplica de novo) e não copia a meta semanal. */
export function copiarSemana(semanaOrigemInicio: string, semanaDestinoInicio: string): Promise<BlocoPlanejado[]> {
  return call<BlocoPlanejado[]>("copiar_semana", { semanaOrigemInicio, semanaDestinoInicio });
}

/* =========================================================================
 * Biblioteca — PDFs e EPUBs com progresso de leitura.
 *
 * Contrato passado pelo orquestrador em 05/09/2026, nomes de função e de
 * campo em português — diferente da convenção "espelha X" do resto deste
 * arquivo porque aqui não existe ainda nenhum struct Rust para espelhar: o
 * backend desta seção está sendo escrito em paralelo, contra este mesmo
 * contrato. Os nomes de comando (`listar_livros` etc.) são decisão deste
 * arquivo, seguindo o padrão snake_case que os outros comandos Rust já usam.
 *
 * Só os comandos que a ESTANTE usa (listar, importar, remover) ganham
 * wrapper nesta rodada. `abrirLivro`, `registrarProgresso`,
 * `listarAnotacoes` e `criarAnotacao` são do leitor em si — fora do escopo
 * desta tarefa (ver `EstadoEmConstrucao` em `ConteudoDeBiblioteca`) — e
 * ficam de fora até a rodada que constrói o leitor, para não deixar wrapper
 * sem chamador no meio do módulo.
 * ========================================================================= */

export type FormatoDeLivro = "pdf" | "epub";

/** Um arquivo importado para a Biblioteca. `pageId` é o vínculo opcional com uma página de Notas. */
export interface Livro {
  id: string;
  /** A página-container do livro. É `NOT NULL` no Rust — todo livro nasce com página. */
  pageId: string;
  format: FormatoDeLivro;
  /** SHA do conteúdo: dois arquivos idênticos importados viram o mesmo arquivo em `media/`. */
  contentHash: string;
  fileName: string;
  /** Como o arquivo se chamava no disco do usuário, para ele reconhecer o que importou. */
  originalFileName: string;
  fileSize: number;
  /** Nome do arquivo de capa extraído do livro, ou `null` quando o livro não tem capa. */
  coverFileName: string | null;
  /** O título que o USUÁRIO escreveu. `null` = nunca editado, e a tela cai no nome do arquivo. */
  metadataTitle: string | null;
  /** O autor que o USUÁRIO escreveu. `null` = nunca editado ("Autor desconhecido" na tela). */
  metadataAuthor: string | null;
  /** Ordem na estante, definida pelo usuário — índice fracionário, mesma convenção de `PageRow.position`. */
  position: string;
  /** Total de páginas (PDF) ou de posições de leitura (EPUB) — o denominador de `progresso`. */
  totalUnits: number | null;
  /** `null` enquanto ninguém checou. `false` num PDF só de imagens: busca e anotação de texto não funcionam nele. */
  hasTextLayer: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Onde o usuário está na leitura de um livro.
 *
 * `furthestFraction`/`furthestLocator` são o ponto mais distante já
 * alcançado — só crescem, mesmo que o usuário volte uma página. É esse par
 * que uma barra de progresso deve ler; `currentFraction`/`currentLocator`
 * são só "onde a leitura abre da próxima vez" e podem estar atrás do mais
 * distante.
 */
export interface ProgressoDeLeitura {
  bookId: string;
  /** `null` enquanto o livro nunca foi aberto — é `Option<String>` no Rust. */
  currentLocator: string | null;
  currentFraction: number;
  furthestLocator: string | null;
  furthestFraction: number;
  status: "unread" | "reading" | "finished";
  /** `null` enquanto o livro nunca foi aberto (`status: "unread"`). */
  lastReadAt: string | null;
  /** `null` até o livro ser marcado como terminado. */
  finishedAt: string | null;
  updatedAt: string;
}

/** Uma linha da estante: o livro, o progresso e os metadados já resolvidos para exibição. */
export interface LivroNaEstante {
  livro: Livro;
  progresso: ProgressoDeLeitura;
  titulo: string;
  /** `null` quando o arquivo não trouxe metadado de autor (comum em PDF escaneado). */
  autor: string | null;
}

/** Toda a estante, na ordem que o backend decidir devolver. */
export function listarLivros(): Promise<LivroNaEstante[]> {
  return call<LivroNaEstante[]>("listar_livros");
}

/**
 * Importa o arquivo de `caminhoDeOrigem` (já escolhido pelo usuário via
 * `@tauri-apps/plugin-dialog`) para a Biblioteca. O backend recusa duplicata
 * por hash do conteúdo do arquivo — quem chama não precisa checar antes.
 */
export function importarLivro(caminhoDeOrigem: string): Promise<LivroNaEstante> {
  return call<LivroNaEstante>("importar_livro", { caminhoDeOrigem });
}

/**
 * Manda o livro para a LIXEIRA. Reversível — ele volta pela lixeira geral,
 * junto com as páginas.
 *
 * O nome e este comentário diziam "remove o arquivo importado, irreversível",
 * e o código nunca fez isso: só marcava a página como excluída. A tela
 * pedia ao usuário que confirmasse uma exclusão permanente que não
 * acontecia. Quem apaga de verdade é `excluirLivroDefinitivamente`.
 */
export function removerLivro(livroId: string): Promise<void> {
  return call<void>("remover_livro", { livroId });
}

/**
 * O livro pronto para ser lido: os metadados, onde parou, e o caminho
 * absoluto do arquivo em `media/`.
 *
 * `caminhoAbsoluto` NÃO é uma URL que a WebView possa carregar direto — ela
 * não tem acesso ao sistema de arquivos. Passe por `convertFileSrc()` do
 * `@tauri-apps/api/core`, que o traduz para o protocolo `asset:`; o escopo
 * dele está declarado em `src-tauri/tauri.conf.json`.
 */
export interface LivroAberto {
  livro: Livro;
  progresso: ProgressoDeLeitura;
  caminhoAbsoluto: string;
}

/** Um marcador, destaque ou nota dentro de um livro. */
export interface Anotacao {
  id: string;
  bookId: string;
  kind: string;
  /**
   * Onde a anotação começa, no vocabulário do formato: número de página no
   * PDF, CFI no EPUB. É texto de propósito — os dois formatos endereçam
   * posição de jeitos incompatíveis, e traduzir para um número comum perderia
   * a precisão que permite reabrir exatamente no mesmo ponto.
   */
  locatorStart: string;
  locatorEnd: string | null;
  /** 0..1 — para desenhar a anotação na barra de progresso sem entender o locator. */
  fraction: number;
  excerpt: string;
  note: string | null;
  color: string | null;
  /** Preenchido quando a anotação virou um bloco numa página. */
  blockId: string | null;
  /** Preenchido quando a anotação virou um cartão de memória. */
  noteId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Abre o livro para leitura e devolve onde a leitura parou. */
export function abrirLivro(livroId: string): Promise<LivroAberto> {
  return call<LivroAberto>("abrir_livro", { livroId });
}

/**
 * Grava onde a leitura está agora — chamado a cada virada de página.
 *
 * `fraction` é 0..1. O ponto MAIS DISTANTE já alcançado avança sozinho no
 * backend e nunca retrocede: voltar uma página não pode encolher a barra de
 * progresso da estante.
 */
export function registrarProgresso(livroId: string, locator: string, fraction: number): Promise<ProgressoDeLeitura> {
  return call<ProgressoDeLeitura>("registrar_progresso", { livroId, locator, fraction });
}

export function listarAnotacoes(livroId: string): Promise<Anotacao[]> {
  return call<Anotacao[]>("listar_anotacoes", { livroId });
}

export function criarAnotacao(entrada: {
  livroId: string;
  kind: string;
  locatorStart: string;
  locatorEnd?: string | null;
  fraction: number;
  excerpt: string;
  note?: string | null;
  color?: string | null;
}): Promise<Anotacao> {
  return call<Anotacao>("criar_anotacao", {
    livroId: entrada.livroId,
    kind: entrada.kind,
    locatorStart: entrada.locatorStart,
    locatorEnd: entrada.locatorEnd ?? null,
    fraction: entrada.fraction,
    excerpt: entrada.excerpt,
    note: entrada.note ?? null,
    color: entrada.color ?? null,
  });
}

/**
 * Apaga o livro de vez: a linha do banco, o arquivo em `media/` e, em
 * cascata, todo o progresso de leitura e as anotações dele. Irreversível.
 *
 * Exige que o livro já esteja na lixeira — chame `removerLivro` antes.
 */
export function excluirLivroDefinitivamente(livroId: string): Promise<void> {
  return call<void>("excluir_livro_definitivamente", { livroId });
}

/**
 * Grava o nome do arquivo de capa do livro; `null` limpa a capa.
 *
 * O arquivo em si é gravado pelo armazenamento de mídia do editor
 * (`storeMediaFile`), o mesmo que a mídia de bloco usa — a extração da imagem
 * (primeira página do PDF, capa do EPUB) acontece no frontend, e só o NOME
 * atravessa o fio. O backend trata esse nome como hostil: nome com barra, com
 * `..` ou caminho absoluto é recusado, porque ele vira caminho dentro de
 * `media/`.
 */
export function definirCapaDoLivro(livroId: string, coverFileName: string | null): Promise<void> {
  return call<void>("definir_capa_do_livro", { livroId, coverFileName });
}

/**
 * Edita título e autor. Três estados por campo, e a diferença importa:
 *
 * - `null` ou ausente: **não mude** este campo;
 * - texto: grava;
 * - texto em branco: **apaga** — o título volta a ser derivado do nome do
 *   arquivo, e o autor volta a "Autor desconhecido".
 *
 * "Apagar" precisa ser dizível, senão o usuário que escreveu um autor errado
 * não teria como voltar a "desconhecido" — só como escrever outra coisa errada.
 */
export function definirMetadadosDoLivro(
  livroId: string,
  titulo: string | null,
  autor: string | null,
): Promise<Livro> {
  return call<Livro>("definir_metadados_do_livro", { livroId, titulo, autor });
}

/** Reordena a estante. `aposLivroId` nulo põe o livro em primeiro — mesma forma de `moverBloco` e `reordenarRaia`. */
export function moverLivro(livroId: string, aposLivroId: string | null): Promise<Livro> {
  return call<Livro>("mover_livro", { livroId, aposLivroId });
}

/**
 * Uma página que o USUÁRIO criou dentro de um livro, para escrever o que quiser.
 *
 * Não tem relação com os capítulos do arquivo: o título é dele, a ordem é dele,
 * e `content` nasce vazio de propósito — cria-se a página primeiro e escreve-se
 * depois.
 */
export interface PaginaDeLivro {
  id: string;
  bookId: string;
  title: string;
  content: string;
  position: string;
  createdAt: string;
  updatedAt: string;
}

/** Nasce no fim da lista do livro, com conteúdo vazio. Título em branco é recusado. */
export function criarPaginaDeLivro(livroId: string, titulo: string): Promise<PaginaDeLivro> {
  return call<PaginaDeLivro>("criar_pagina_de_livro", { livroId, titulo });
}

export function listarPaginasDoLivro(livroId: string): Promise<PaginaDeLivro[]> {
  return call<PaginaDeLivro[]>("listar_paginas_do_livro", { livroId });
}

export function renomearPaginaDeLivro(id: string, titulo: string): Promise<PaginaDeLivro> {
  return call<PaginaDeLivro>("renomear_pagina_de_livro", { id, titulo });
}

/** Substitui o conteúdo inteiro da página. Conteúdo vazio é válido. */
export function escreverConteudoDaPagina(id: string, conteudo: string): Promise<PaginaDeLivro> {
  return call<PaginaDeLivro>("escrever_conteudo_da_pagina", { id, conteudo });
}

/** `aposPaginaId` nulo põe em primeiro. Só reordena dentro do mesmo livro — o livro vem da própria página. */
export function moverPaginaDeLivro(paginaId: string, aposPaginaId: string | null): Promise<PaginaDeLivro> {
  return call<PaginaDeLivro>("mover_pagina_de_livro", { paginaId, aposPaginaId });
}

export function removerPaginaDeLivro(id: string): Promise<void> {
  return call<void>("remover_pagina_de_livro", { id });
}

/** O resumo que o leitor escreveu para um capítulo. Um por capítulo: salvar de novo substitui. */
export interface ResumoDeCapitulo {
  id: string;
  bookId: string;
  /** Endereço do capítulo. É TEXT porque num EPUB é um href do índice e num PDF é um número de página — o formato de um não serve para o outro. */
  chapterLocator: string;
  chapterTitle: string | null;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

/** Upsert por `(bookId, chapterLocator)`: salvar duas vezes no mesmo capítulo substitui, não duplica. */
export function salvarResumoDeCapitulo(
  livroId: string,
  chapterLocator: string,
  chapterTitle: string | null,
  resumo: string,
): Promise<ResumoDeCapitulo> {
  return call<ResumoDeCapitulo>("salvar_resumo_de_capitulo", { livroId, chapterLocator, chapterTitle, resumo });
}

export function listarResumosDoLivro(livroId: string): Promise<ResumoDeCapitulo[]> {
  return call<ResumoDeCapitulo[]>("listar_resumos_do_livro", { livroId });
}

export function removerResumoDeCapitulo(id: string): Promise<void> {
  return call<void>("remover_resumo_de_capitulo", { id });
}

/** Uma palavra nova colhida durante a leitura — a matéria-prima de um cartão. */
export interface PalavraColetada {
  id: string;
  bookId: string;
  term: string;
  /** A frase de onde a palavra veio. É o que dá sentido a ela depois, e é o que vira a frente do cartão. */
  contextSnippet: string | null;
  note: string | null;
  locator: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A mesma palavra colhida duas vezes no mesmo livro não cria linha nova (a comparação ignora caixa e acento). */
export function coletarPalavra(
  livroId: string,
  termo: string,
  trechoDeContexto: string | null,
  nota: string | null,
  locator: string | null,
): Promise<PalavraColetada> {
  return call<PalavraColetada>("coletar_palavra", { livroId, termo, trechoDeContexto, nota, locator });
}

export function listarPalavrasDoLivro(livroId: string): Promise<PalavraColetada[]> {
  return call<PalavraColetada[]>("listar_palavras_do_livro", { livroId });
}

/** A lista geral, de todos os livros — para revisar vocabulário fora da leitura. `termoBusca` nulo traz tudo. */
export function listarPalavras(termoBusca: string | null): Promise<PalavraColetada[]> {
  return call<PalavraColetada[]>("listar_palavras", { termoBusca });
}

export function atualizarNotaDaPalavra(id: string, nota: string | null): Promise<PalavraColetada> {
  return call<PalavraColetada>("atualizar_nota_da_palavra", { id, nota });
}

export function removerPalavra(id: string): Promise<void> {
  return call<void>("remover_palavra", { id });
}

/** Uma categoria da estante. O nome é único ignorando caixa e acento: "Ficção" e "ficcao" são a mesma categoria. */
export interface Categoria {
  id: string;
  name: string;
  /**
   * `null` = categoria de raiz. Mesma convenção de `PageRow.parent_id`: a
   * lista vem PLANA, com o ponteiro para o pai, e quem desenha monta a árvore
   * — do mesmo jeito que a árvore de páginas de Notas já faz.
   */
  parentId: string | null;
  position: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * As categorias de cada livro, agrupadas — uma consulta só para a estante inteira.
 *
 * Existe em vez de um campo dentro de `LivroNaEstante` porque a relação é
 * um-para-muitos: embutir multiplicaria a linha do livro por categoria e
 * exigiria reagrupar de qualquer jeito. Livro sem categoria nenhuma não
 * aparece nesta lista.
 */
export interface CategoriasDoLivro {
  livroId: string;
  categorias: Categoria[];
}

/** Nome vazio, ou já usado por outra categoria (ignorando caixa e acento), é recusado — e a mensagem diz qual categoria ocupa o nome. */
export function criarCategoria(nome: string, parentId: string | null = null): Promise<Categoria> {
  return call<Categoria>("criar_categoria", { nome, parentId });
}

/**
 * Move a categoria para outro pai; `novoParentId` nulo a leva para a raiz.
 *
 * Mover uma categoria para dentro de um descendente dela é RECUSADO: um ciclo
 * aqui não é um desenho estranho, é uma consulta recursiva que não termina e
 * uma tela que trava.
 */
export function moverCategoria(id: string, novoParentId: string | null): Promise<Categoria> {
  return call<Categoria>("mover_categoria", { id, novoParentId });
}

/**
 * Os ids dos livros da categoria E de todos os descendentes dela.
 *
 * É o que faz filtrar por "Fantasia" mostrar o que está em "Fantasia > Épico":
 * sem isso o pai apareceria como uma pasta vazia tendo livros um nível abaixo.
 */
export function listarLivrosDaCategoria(categoriaId: string): Promise<string[]> {
  return call<string[]>("listar_livros_da_categoria", { categoriaId });
}

export function listarCategorias(): Promise<Categoria[]> {
  return call<Categoria[]>("listar_categorias", {});
}

export function renomearCategoria(id: string, nome: string): Promise<Categoria> {
  return call<Categoria>("renomear_categoria", { id, nome });
}

/** Remove a categoria e as ligações dela. NENHUM livro é apagado. */
export function removerCategoria(id: string): Promise<void> {
  return call<void>("remover_categoria", { id });
}

/** Substitui o conjunto INTEIRO de categorias do livro, numa transação só: um id inválido na lista recusa tudo, sem deixar metade aplicada. */
export function definirCategoriasDoLivro(livroId: string, categoriaIds: string[]): Promise<void> {
  return call<void>("definir_categorias_do_livro", { livroId, categoriaIds });
}

export function listarCategoriasDoLivro(livroId: string): Promise<Categoria[]> {
  return call<Categoria[]>("listar_categorias_do_livro", { livroId });
}

/** As categorias de todos os livros de uma vez — é o que a estante usa para filtrar sem uma consulta por livro. */
export function listarCategoriasPorLivro(): Promise<CategoriasDoLivro[]> {
  return call<CategoriasDoLivro[]>("listar_categorias_por_livro", {});
}

// ---- Trilha -------------------------------------------------------------

/**
 * A sétima seção: as etapas de estudo que o usuário segue pelas FLECHAS.
 *
 * O eixo é DEPENDÊNCIA, NUNCA TEMPO — decisão travada em
 * `src-tauri/migrations/0023_trilha.sql`, e a razão de nada aqui ter
 * coordenada. A coluna de cada etapa (`level`) é DERIVADA do grafo a cada
 * abertura; guardar (x, y) permitiria o desenho contradizer a regra de
 * desbloqueio.
 *
 * Três coisas que a Trilha reusa em vez de duplicar, e que explicam por que
 * este trecho é menor do que a feature parece:
 * - etapa é uma página-registro (`pages` com `database_id`), então abrir uma
 *   etapa mostra a página inteira com o corpo de blocos, sem nada novo;
 * - flecha é `database_record_dependencies`, a MESMA aresta de "B bloqueada
 *   por A" da view Tabela — remover a dependência por lá faz a flecha sumir;
 * - raia é um valor de propriedade, já gravado em `database_record_values`.
 */
export interface ConfiguracaoTrilha {
  viewId: string;
  /** `null` = uma raia só, sem título, com todas as etapas. É como a Trilha nasce, e é estado válido. */
  groupPropertyId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Uma faixa horizontal: "estudos de T.I." numa, um fluxo diferente na de baixo. */
export interface RaiaDaTrilha {
  viewId: string;
  laneValue: string;
  position: string;
  isCollapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Uma etapa já resolvida para desenho: onde ela cai no grafo e se dá para começar. */
export interface EtapaDaTrilha {
  id: string;
  title: string;
  icon: string | null;
  laneValue: string;
  /**
   * `pages.position` (índice fracionário) desta etapa — dá para o frontend
   * ordenar verticalmente por ela dentro da raia (antes caía para
   * `title.localeCompare`, que travava qualquer inversão sem renomear).
   * Mesma coluna que `movePage` já escreve; nada nasce aqui, só passa a ser
   * lido — ver o comentário de `Etapa.position` em `src-tauri/src/db/trilha.rs`.
   */
  position: string;
  /** Derivado do grafo: 0 para quem não tem flecha entrando, senão um nível depois da bloqueadora mais profunda. */
  level: number;
  /**
   * `true` quando a etapa participa de um ciclo de dependências.
   *
   * A ⇒ B ⇒ A é gravável no banco, então a tela precisa saber mostrar isso em
   * vez de fingir uma ordem que não existe. Etapa em ciclo nunca desbloqueia
   * sozinha — quem a olha precisa quebrar o ciclo.
   */
  inCycle: boolean;
  /** Todas as bloqueadoras concluídas. É a pergunta que a tela faz o tempo todo. */
  isUnlocked: boolean;
  /** Onde a etapa está em relação às decisões que a alimentam. Derivado a cada leitura, nada gravado. */
  situacaoNoCaminho: SituacaoNoCaminho;
  /** `null` = nem começou. Sem progresso gravado não há linha, e não há estado. */
  state: "in_progress" | "done" | null;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * A situação de uma etapa em relação aos caminhos de decisão que levam até ela.
 *
 * - `ativo`: nenhuma flecha de entrada está morta, ou não há flecha nenhuma.
 *   É o estado de toda etapa comum.
 * - `aguardandoEscolha`: alguma flecha de entrada tem rótulo cuja decisão de
 *   origem ainda não foi escolhida — a etapa está em suspenso.
 * - `descartado`: a etapa tem flechas de entrada e TODAS estão mortas (o
 *   rótulo delas perdeu a escolha). Continua visível e na mesma coluna, nunca
 *   escondida e nunca apagada: sumir com o ramo faria o desenho mentir sobre
 *   o grafo.
 */
export type SituacaoNoCaminho = "ativo" | "aguardandoEscolha" | "descartado";

/** Uma flecha: `blockingId` precisa terminar antes de `blockedId` começar. */
export interface FlechaDaTrilha {
  blockedId: string;
  blockingId: string;
  /**
   * O rótulo do caminho, ou `null` para pré-requisito incondicional.
   *
   * Só pode ser preenchido quando `blockingId` é uma decisão. Um caminho é o
   * conjunto de todas as flechas que saem da mesma decisão com o mesmo rótulo.
   */
  pathLabel: string | null;
}

export interface ProgressoDaEtapa {
  stepId: string;
  state: "in_progress" | "done";
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

/** O que a etapa manda estudar: uma página, um baralho ou um livro. */
export interface MaterialDaEtapa {
  id: string;
  stepId: string;
  kind: "page" | "deck" | "book";
  pageId: string | null;
  deckId: string | null;
  position: string;
  createdAt: string;
}

/** A cena inteira, numa chamada só — a tela monta tudo a partir daqui. */
/**
 * Uma etapa que RAMIFICA: dela saem vários caminhos, e o usuário escolhe um.
 *
 * A existência desta linha é o que faz a etapa ser uma decisão — não há campo
 * "tipo de etapa" em lugar nenhum. Etapa comum simplesmente não tem entrada
 * aqui.
 */
export interface Decisao {
  stepId: string;
  /** `null` = ainda não escolheu. É o estado de nascença, e é válido: a decisão existe, os caminhos existem, e nenhum deles está liberado. */
  chosenLabel: string | null;
  chosenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A prévia do que aconteceria ao trocar a escolha de uma decisão — leitura
 * pura, não muda nada.
 *
 * Existe para a tela poder avisar ANTES: trocar de caminho nunca apaga
 * progresso (voltar para a escolha antiga restaura a cena exata), mas o
 * usuário precisa saber que existe trabalho feito atrás do caminho que ele
 * está abandonando.
 */
export interface ImpactoDaTroca {
  /** Etapas hoje descartadas que voltariam a valer. */
  entramNoCaminho: string[];
  /** Etapas que valem hoje e passariam a descartadas. */
  saemDoCaminho: string[];
  /** Subconjunto de `saemDoCaminho` que tem progresso registrado. Nada é apagado — mas é o número que a confirmação precisa mostrar. */
  saemComProgresso: string[];
  /** Subconjunto de `saemDoCaminho` já concluído. */
  saemConcluidas: string[];
}

export interface Trilha {
  configuracao: ConfiguracaoTrilha;
  raias: RaiaDaTrilha[];
  etapas: EtapaDaTrilha[];
  flechas: FlechaDaTrilha[];
  materiais: MaterialDaEtapa[];
  decisoes: Decisao[];
}

export function obterTrilha(viewId: string): Promise<Trilha> {
  return call<Trilha>("obter_trilha", { viewId });
}

/** Marca a etapa como decisão. Idempotente: marcar duas vezes não é erro. */
export function marcarEtapaComoDecisao(stepId: string): Promise<Decisao> {
  return call<Decisao>("marcar_etapa_como_decisao", { stepId });
}

/** Desfaz a marcação. RECUSA enquanto existir caminho rotulado saindo dela — aceitar em silêncio transformaria todo ramo em pré-requisito obrigatório de uma vez. */
export function desmarcarEtapaComoDecisao(stepId: string): Promise<void> {
  return call<void>("desmarcar_etapa_como_decisao", { stepId });
}

/** Escolhe um caminho, ou zera a escolha com `null`. Nenhum progresso é apagado: voltar para a escolha anterior restaura a cena exata. */
export function escolherCaminho(decisionId: string, pathLabel: string | null): Promise<Decisao> {
  return call<Decisao>("escolher_caminho", { decisionId, pathLabel });
}

/** Renomeia um caminho, ou o dissolve com `novoRotulo` nulo (as flechas dele viram pré-requisito incondicional). Devolve quantas flechas mudaram. */
export function renomearCaminho(decisionId: string, rotuloAtual: string, novoRotulo: string | null): Promise<number> {
  return call<number>("renomear_caminho", { decisionId, rotuloAtual, novoRotulo });
}

/** O que aconteceria se a escolha mudasse — para a tela avisar antes, não depois. */
export function preverTrocaDeCaminho(decisionId: string, novoRotulo: string | null): Promise<ImpactoDaTroca> {
  return call<ImpactoDaTroca>("prever_troca_de_caminho", { decisionId, novoRotulo });
}

/** `groupPropertyId` nulo cria a Trilha com uma raia só, sem título. */
export function criarTrilha(viewId: string, groupPropertyId?: string | null): Promise<ConfiguracaoTrilha> {
  return call<ConfiguracaoTrilha>("criar_trilha", { viewId, groupPropertyId: groupPropertyId ?? null });
}

/**
 * Um resumo de trilha — o bastante para o painel de troca listar e para
 * `localizacao.ts` guardar o ponteiro (`containerPageId` + `viewId`) da que
 * o usuário escolher, sem carregar a cena inteira (`Trilha`) só para
 * desenhar uma linha da lista.
 */
export interface TrilhaResumo {
  viewId: string;
  databaseId: string;
  containerPageId: string;
  nome: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Toda trilha do workspace — a base do painel de troca (item 1: hoje só
 * existe UMA, presa no `localStorage`). Varre o banco inteiro, não uma
 * página de cada vez: descobrir QUAIS páginas têm trilha é justamente o que
 * faltava (ver o comentário de `localizacao.ts`).
 */
export function listarTrilhas(): Promise<TrilhaResumo[]> {
  return call<TrilhaResumo[]>("listar_trilhas");
}

/**
 * Configura DEPOIS DA CRIAÇÃO a propriedade que agrupa a trilha em raias —
 * sem isto, uma trilha nascida sem uma (o único caminho que a UI oferecia
 * antes desta entrega) ficava presa para sempre em "uma raia só". `null`
 * devolve a trilha a esse mesmo estado (TRL-014), sem apagar raia nem etapa.
 */
export function definirPropriedadeDeAgrupamentoDaTrilha(
  viewId: string,
  groupPropertyId: string | null,
): Promise<ConfiguracaoTrilha> {
  return call<ConfiguracaoTrilha>("definir_propriedade_de_agrupamento_da_trilha", { viewId, groupPropertyId });
}

export function criarRaia(viewId: string, laneValue: string): Promise<RaiaDaTrilha> {
  return call<RaiaDaTrilha>("criar_raia", { viewId, laneValue });
}

/**
 * `valorAtual` — não `laneValue` — é o nome que o fio espera: o comando Rust
 * (`trilha_commands::renomear_raia`) declara o parâmetro como `valor_atual`,
 * e o Tauri liga argumento por NOME (convertido para camelCase), não por
 * posição. Antes desta correção este wrapper mandava `laneValue`, que não
 * bate com nenhum parâmetro do comando — invisível porque nenhuma tela
 * ainda chamava `renomearRaia` de verdade (`renomear_raia` só existia em
 * `REGISTRADOS_SEM_TELA`), então a rejeição em runtime nunca apareceu.
 */
export function renomearRaia(viewId: string, valorAtual: string, novoValor: string): Promise<RaiaDaTrilha> {
  return call<RaiaDaTrilha>("renomear_raia", { viewId, valorAtual, novoValor });
}

/** `aposLaneValue` nulo põe a raia em primeiro. */
export function reordenarRaia(
  viewId: string,
  laneValue: string,
  aposLaneValue: string | null,
): Promise<RaiaDaTrilha> {
  return call<RaiaDaTrilha>("reordenar_raia", { viewId, laneValue, aposLaneValue });
}

export function definirRaiaRecolhida(
  viewId: string,
  laneValue: string,
  recolhida: boolean,
): Promise<RaiaDaTrilha> {
  return call<RaiaDaTrilha>("definir_raia_recolhida", { viewId, laneValue, recolhida });
}

/**
 * Apaga a raia — NUNCA apaga as etapas que estavam nela (TRL-014): elas ficam
 * sem raia e passam a aparecer na faixa "Sem raia". Ver o comentário de
 * `TrilhaRepository::remover_raia`.
 *
 * NÃO é idempotente, ao contrário de `apagarFlecha`: apagar a mesma raia duas
 * vezes rejeita com `AppError` de `kind: "not_found"`, mesma convenção de
 * `reordenarRaia`/`definirRaiaRecolhida`.
 */
export function removerRaia(viewId: string, laneValue: string): Promise<void> {
  return call<void>("remover_raia", { viewId, laneValue });
}

/**
 * Move a etapa para outra raia — que é gravar outro valor de propriedade, não
 * mexer em raia nenhuma. Por isso não devolve `RaiaDaTrilha`.
 */
export function moverEtapaParaRaia(stepId: string, viewId: string, laneValue: string): Promise<void> {
  return call<void>("mover_etapa_para_raia", { stepId, viewId, laneValue });
}

/**
 * O parâmetro no fio se chama `stateValue`, não `state`: `state` colide com o
 * `State<AppState>` que o Tauri injeta em todo comando.
 */
export function marcarProgressoEtapa(
  stepId: string,
  estado: "in_progress" | "done",
): Promise<ProgressoDaEtapa> {
  return call<ProgressoDaEtapa>("marcar_progresso_etapa", { stepId, stateValue: estado });
}

export function desmarcarProgressoEtapa(stepId: string): Promise<void> {
  return call<void>("desmarcar_progresso_etapa", { stepId });
}

export function etapaEstaDesbloqueada(stepId: string): Promise<boolean> {
  return call<boolean>("etapa_esta_desbloqueada", { stepId });
}

/** `pageId` e `deckId` são exclusivos entre si e precisam bater com `kind`. */
export function anexarMaterialEtapa(
  stepId: string,
  kind: "page" | "deck" | "book",
  pageId: string | null,
  deckId: string | null,
): Promise<MaterialDaEtapa> {
  return call<MaterialDaEtapa>("anexar_material_etapa", { stepId, kind, pageId, deckId });
}

export function removerMaterialEtapa(materialId: string): Promise<void> {
  return call<void>("remover_material_etapa", { materialId });
}

/** O que volta de `criarTrilhaCompleta`: a trilha pronta e o database que nasceu com ela. */
export interface TrilhaRecemCriada {
  databaseId: string;
  trilha: Trilha;
}

/**
 * Cria a trilha inteira num passo: o database dentro da página, a view do
 * tipo `trail` e a configuração de agrupamento.
 *
 * Existe para o usuário nunca precisar aprender o que é "database" e "view"
 * só para montar um plano de estudos. Sem isto seriam quatro chamadas em
 * ordem certa, e errar a ordem deixaria lixo pela metade no banco.
 *
 * RESSALVA HONESTA sobre atomicidade: os passos são compensados em caso de
 * falha, não envolvidos numa transação de verdade — o `DatabaseRepository`
 * recebe o pool, não uma transação, então cada `CREATE` comita sozinho. Uma
 * falha comum é desfeita; uma queda de processo no meio deixaria o database
 * órfão. Está registrado como dívida.
 */
export function criarTrilhaCompleta(
  containerPageId: string,
  databaseName: string,
  viewName: string,
  groupPropertyId?: string | null,
): Promise<TrilhaRecemCriada> {
  return call<TrilhaRecemCriada>("criar_trilha_completa", {
    containerPageId,
    databaseName,
    viewName,
    groupPropertyId: groupPropertyId ?? null,
  });
}

/**
 * Cria uma etapa e já a coloca numa raia. `laneValue` vazio = sem raia, que é
 * estado válido (TRL-014), não erro.
 *
 * Pedir raia nomeada numa trilha sem propriedade de agrupamento é recusado
 * ANTES de qualquer escrita — a ordem importa: a recusa depois de gravar
 * deixava uma etapa fantasma no banco enquanto a tela concluía que nada
 * tinha mudado.
 */
export function criarEtapa(viewId: string, title: string, laneValue: string): Promise<EtapaDaTrilha> {
  return call<EtapaDaTrilha>("criar_etapa", { viewId, title, laneValue });
}

/**
 * Apaga (manda para a lixeira de Notas) a etapa — reversível, mesmo destino
 * de `trashPage`: `restorePage(id)` devolve a página inteira, com progresso,
 * materiais e decisão intactos.
 *
 * Cascata que o backend garante e que a tela precisa avisar ANTES de chamar
 * isto (ver `TrilhaRepository::remover_etapa`):
 * - toda flecha que toca a etapa (nos dois sentidos) é apagada na mesma
 *   transação — NÃO HÁ RELIGAÇÃO AUTOMÁTICA. Numa cadeia A → B → C, apagar B
 *   deixa C sem bloqueadora (desbloqueada), e A e C continuam sem relação
 *   nenhuma entre si;
 * - se a etapa era uma decisão com caminho escolhido, as flechas rotuladas
 *   somem e a escolha é zerada por gatilho — não é recusado.
 *
 * Devolve a `PageRow` já na lixeira (`deleted_at` preenchido), pelo mesmo
 * motivo de `trashPage`. Rejeita com `AppError` se a página já estiver na
 * lixeira.
 */
export function removerEtapa(stepId: string): Promise<PageRow> {
  return call<PageRow>("remover_etapa", { stepId });
}

/**
 * Liga duas etapas: `blockingId` precisa terminar antes de `blockedId`
 * começar. É a flecha que o usuário desenha.
 *
 * Criar a mesma flecha duas vezes não é erro — arrastar a mesma ligação de
 * novo não fez nada de errado.
 *
 * FECHAR UM CICLO É PERMITIDO de propósito (A bloqueia B, B bloqueia A).
 * Barrar aqui pareceria mais seguro, mas o cálculo de níveis já trata ciclo e
 * marca as etapas com `inCycle` — barrar na escrita tornaria esse tratamento
 * código morto, e esconderia do usuário um estado que ele mesmo criou e
 * precisa enxergar para desfazer.
 */
/**
 * `pathLabel` só é aceito quando `blockingId` já é uma decisão. Arrastar a
 * MESMA flecha de novo sem rótulo nunca apaga um rótulo já gravado —
 * desrotular é `renomearCaminho`, operação explícita, nunca efeito colateral.
 */
export function criarFlecha(blockedId: string, blockingId: string, pathLabel?: string | null): Promise<FlechaDaTrilha> {
  return call<FlechaDaTrilha>("criar_flecha", { blockedId, blockingId, pathLabel: pathLabel ?? null });
}

/** Apagar flecha que não existe não é erro. */
export function apagarFlecha(blockedId: string, blockingId: string): Promise<void> {
  return call<void>("apagar_flecha", { blockedId, blockingId });
}

// ---- Databases: a espinha da Fase 3 ------------------------------------

/**
 * O sistema de database do produto — o "Notion database": uma coleção de
 * registros com propriedades tipadas, vista de cinco jeitos (tabela, quadro,
 * lista, calendário e trilha).
 *
 * Este trecho é o DÉCIMO elo de uma corrente que existia inteira e desligada.
 * O subsistema já tinha nove migrações aplicadas, ~2.600 linhas de repositório
 * Rust para valor, relação e efeito, o motor de fórmula completo, e 64
 * arquivos de componente em `src/features/databases/` — e os únicos
 * `INSERT INTO databases` do projeto viviam dentro de fixtures de teste. O
 * Rust testava contra dados que só os testes criavam; os componentes
 * conversavam com nada.
 *
 * Um registro É uma página (`pages` com `database_id`), decisão da migração
 * 0007 — é por isso que abrir um registro mostra a página inteira com o corpo
 * de blocos, e por isso `createRecord` devolve `PageRow`.
 */

/** Espelha `DatabaseRow`. `config` guarda o que não precisa de chave estrangeira. */
export interface DatabaseRow {
  id: string;
  containerPageId: string;
  name: string;
  isLocked: boolean;
  config: unknown;
  /** Sobe a cada escrita — é como a tela sabe que precisa recarregar. */
  dataVersion: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Os quinze tipos de propriedade, iguais a `VALID_PROPERTY_TYPES` em
 * `src-tauri/src/db/databases.rs`.
 *
 * `database_properties.property_type` é TEXT **sem CHECK** no banco: quem
 * garante o conjunto é a validação da aplicação, dos dois lados. Um valor fora
 * desta lista grava sem erro e produz uma propriedade que nenhuma tela sabe
 * desenhar — por isso o tipo é fechado aqui também, e não `string`.
 */
export type PropertyType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "checkbox"
  | "url"
  | "files"
  | "person"
  | "formula"
  | "relation"
  | "rollup"
  | "created_time"
  | "last_edited_time";

/** Os cinco tipos de view. `trail` é a Trilha, acrescentada pela migração 0023. */
export type ViewType = "table" | "board" | "list" | "calendar" | "trail";

export interface DatabasePropertyRow {
  id: string;
  databaseId: string;
  name: string;
  propertyType: PropertyType;
  config: unknown;
  position: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseViewRow {
  id: string;
  databaseId: string;
  name: string;
  viewType: ViewType;
  /** Filtro, ordenação e colunas visíveis. O que aponta para outra tabela NÃO mora aqui: blob não tem chave estrangeira. */
  config: unknown;
  position: string;
  createdAt: string;
  updatedAt: string;
}

/** O valor de uma propriedade num registro. `sortNum`/`sortText` são colunas derivadas para ordenar sem reparsear o JSON. */
export interface RecordValueRow {
  recordId: string;
  propertyId: string;
  value: unknown;
  sortNum: number | null;
  sortText: string | null;
  updatedAt: string;
}

/** Um registro com os valores já resolvidos — a linha da view Tabela. */
export interface DatabaseRecord {
  page: PageRow;
  values: RecordValueRow[];
}

export function createDatabase(containerPageId: string, name: string): Promise<DatabaseRow> {
  return call<DatabaseRow>("create_database", { containerPageId, name });
}

export function getDatabase(id: string): Promise<DatabaseRow> {
  return call<DatabaseRow>("get_database", { id });
}

export function listDatabasesInPage(containerPageId: string): Promise<DatabaseRow[]> {
  return call<DatabaseRow[]>("list_databases_in_page", { containerPageId });
}

export function renameDatabase(id: string, name: string): Promise<DatabaseRow> {
  return call<DatabaseRow>("rename_database", { id, name });
}

/** Apaga o database, e com ele propriedades, views, registros e valores, em cascata. */
export function deleteDatabase(id: string): Promise<void> {
  return call<void>("delete_database", { id });
}

export function createProperty(
  databaseId: string,
  name: string,
  propertyType: PropertyType,
  config?: unknown,
): Promise<DatabasePropertyRow> {
  return call<DatabasePropertyRow>("create_property", {
    databaseId,
    name,
    propertyType,
    config: config ?? null,
  });
}

export function listProperties(databaseId: string): Promise<DatabasePropertyRow[]> {
  return call<DatabasePropertyRow[]>("list_properties", { databaseId });
}

export function renameProperty(id: string, name: string): Promise<DatabasePropertyRow> {
  return call<DatabasePropertyRow>("rename_property", { id, name });
}

export function changePropertyType(id: string, newType: PropertyType): Promise<DatabasePropertyRow> {
  return call<DatabasePropertyRow>("change_property_type", { id, newType });
}

/**
 * Substitui a `database_properties.config` inteira (a expressão de uma
 * Fórmula, o formato de um Número). O Rust recusa config que não seja objeto
 * JSON e propriedade `relation`/`rollup`. É o que permite editar a expressão
 * de uma Fórmula depois de criada — e o que o menu de coluna manda junto
 * de `change_property_type`, para o `config` do tipo antigo não sobrar.
 */
export function setPropertyConfig(id: string, config: unknown): Promise<DatabasePropertyRow> {
  return call<DatabasePropertyRow>("set_property_config", { id, config });
}

/** `afterPropertyId` nulo põe a propriedade em primeiro. */
export function reorderProperty(
  databaseId: string,
  id: string,
  afterPropertyId: string | null,
): Promise<DatabasePropertyRow> {
  return call<DatabasePropertyRow>("reorder_property", { databaseId, id, afterPropertyId });
}

/**
 * Apaga a propriedade e os valores dela.
 *
 * Uma Trilha que agrupava por esta propriedade continua existindo: o
 * `groupPropertyId` dela vira `null` e ela volta a ser uma raia só — estado
 * válido, e não uma view apontando para linha morta.
 */
export function deleteProperty(id: string): Promise<void> {
  return call<void>("delete_property", { id });
}

export function createView(
  databaseId: string,
  name: string,
  viewType: ViewType,
  config?: unknown,
): Promise<DatabaseViewRow> {
  return call<DatabaseViewRow>("create_view", { databaseId, name, viewType, config: config ?? null });
}

export function listViews(databaseId: string): Promise<DatabaseViewRow[]> {
  return call<DatabaseViewRow[]>("list_views", { databaseId });
}

export function renameView(id: string, name: string): Promise<DatabaseViewRow> {
  return call<DatabaseViewRow>("rename_view", { id, name });
}

export function setViewConfig(id: string, config: unknown): Promise<DatabaseViewRow> {
  return call<DatabaseViewRow>("set_view_config", { id, config });
}

/** `afterViewId` nulo põe a view em primeiro. */
export function reorderView(
  databaseId: string,
  id: string,
  afterViewId: string | null,
): Promise<DatabaseViewRow> {
  return call<DatabaseViewRow>("reorder_view", { databaseId, id, afterViewId });
}

export function deleteView(id: string): Promise<void> {
  return call<void>("delete_view", { id });
}

/** Cria o registro — que é uma página com `database_id`, por isso devolve `PageRow`. */
export function createRecord(databaseId: string, title: string): Promise<PageRow> {
  return call<PageRow>("create_record", { databaseId, title });
}

export function listRecords(databaseId: string): Promise<DatabaseRecord[]> {
  return call<DatabaseRecord[]>("list_records", { databaseId });
}

/**
 * Espelha `RecordValueChangeInput` (`src-tauri/src/db/record_values.rs`) —
 * tipo de ENTRADA (`Deserialize`), por isso `contrato-ipc.test.ts` não o
 * confere. `value: null` significa "limpe esta célula": o Rust normaliza por
 * tipo e, quando o resultado é vazio, APAGA a linha (I1) em vez de gravar
 * um JSON vazio.
 */
export interface RecordValueChangeInput {
  recordId: string;
  propertyId: string;
  value: unknown;
}

/** Espelha `AppliedRecordValue`. `value: null` = a linha não existe mais (I1), nunca um "vazio" serializado. */
export interface AppliedRecordValue {
  recordId: string;
  propertyId: string;
  value: RecordValueRow | null;
}

/** Espelha `AppliedChanges` — um resultado por mudança pedida, na mesma ordem. */
export interface AppliedChanges {
  results: AppliedRecordValue[];
}

/**
 * Aplica um LOTE de valores de célula numa única transação (I4). A célula
 * da Tabela chama com um item; colar uma linha inteira chamaria com vários —
 * a atomicidade é do repositório, não de quem chama.
 */
export function applyRecordValueChanges(changes: RecordValueChangeInput[]): Promise<AppliedChanges> {
  return call<AppliedChanges>("apply_record_value_changes", { changes });
}

// ---- Fórmulas -------------------------------------------------------------
//
// Espelha os três comandos `#[tauri::command]` de
// `src-tauri/src/ipc/formula_commands.rs` — `validate_formula`,
// `preview_formula`, `list_formula_functions`. Nenhuma forma exata destes
// DTOs foi congelada pela arquitetura além do nome do comando e dos
// parâmetros (§9); os campos abaixo são a parte que o comentário de módulo de
// `formula_commands.rs` chama de "contrato publicado".

/** Espelha `DiagnosticDto` — um erro/aviso do compilador de fórmula, com a posição já convertida de bytes UTF-8 (o que `formula::core` produz) para unidades UTF-16 (o que o JavaScript usa). */
export interface DiagnosticDto {
  message: string;
  start: number;
  end: number;
}

/** Espelha `FormulaValidation` — o que `validateFormula` devolve. */
export interface FormulaValidation {
  valid: boolean;
  /** `Type::to_string()` em português ("número", "lista<página>", ...). Ausente quando `valid` é `false`. */
  returnType: string | null;
  diagnostics: DiagnosticDto[];
  /** Toda propriedade referenciada via `prop()` — a aresta que a cascata de I4 e a detecção de ciclo entre propriedades de fórmula precisam. Vazio quando `valid` é `false`. */
  dependsOn: string[];
}

/** Espelha `FormulaPreview` — o que `previewFormula` devolve. */
export interface FormulaPreview {
  /** `Value::to_json()` — `null` para `Value::Empty` ou em caso de erro. Tipo aberto porque o valor pode ser número, texto, booleano, lista, objeto de data ou nulo. */
  value: unknown;
  diagnostics: DiagnosticDto[];
}

/** Espelha `FormulaFunctionDoc` — uma entrada da paleta/autocompletar do editor de fórmula. */
export interface FormulaFunctionDoc {
  name: string;
  category: string;
  doc: string;
  /** Já em português, pronto para a paleta: "exatamente 1 argumento", "entre 1 e 3 argumentos", etc. */
  arity: string;
}

/**
 * `validate_formula`: compila `expression` contra o schema de `databaseId` e
 * diz se é válida. `propertyId` é a propriedade que a fórmula está SENDO
 * SALVA para (`null`/ausente ao criar uma nova propriedade de fórmula) — usado
 * só para recusar auto-referência direta (`A: A + 1`).
 */
export function validateFormula(
  databaseId: string,
  propertyId: string | null | undefined,
  expression: string,
): Promise<FormulaValidation> {
  return call<FormulaValidation>("validate_formula", { databaseId, propertyId: propertyId ?? null, expression });
}

/**
 * `preview_formula`: avalia `expression` como se já fosse a fórmula de uma
 * propriedade, contra os valores REAIS de `recordId`. Uma fórmula que
 * atravessa uma relação de verdade mostra a relação como vazia nesta prévia
 * (limitação nomeada no comentário de módulo de `formula_commands.rs`).
 */
export function previewFormula(databaseId: string, recordId: string, expression: string): Promise<FormulaPreview> {
  return call<FormulaPreview>("preview_formula", { databaseId, recordId, expression });
}

/** `list_formula_functions`: a paleta/autocompletar do editor de fórmula, com nome, categoria, documentação e aridade de cada função. */
export function listFormulaFunctions(): Promise<FormulaFunctionDoc[]> {
  return call<FormulaFunctionDoc[]>("list_formula_functions");
}

/** Espelha `FormulaColumnValue` — o valor calculado de UM registro, na saída de `evaluateFormulaColumn`. */
export interface FormulaColumnValue {
  recordId: string;
  /** `Value::to_json()` — `null` para vazio, e para TODO registro quando a expressão não compila (ver `evaluateFormulaColumn`). */
  value: unknown;
}

/**
 * `evaluate_formula_column`: avalia a fórmula da propriedade `propertyId`
 * contra TODOS os registros de `databaseId` numa chamada só — é o que a
 * coluna da Tabela usa (uma chamada por coluna, nunca uma por linha;
 * `list_records` não computa fórmula). Quando a expressão não compila
 * (inclusive quando referencia outra fórmula, DBS-084), todo registro volta
 * com `value: null` — o Rust não derruba a coluna; quem chama precisa
 * distinguir esse caso de "vazio" com `validateFormula`.
 */
export function evaluateFormulaColumn(databaseId: string, propertyId: string): Promise<FormulaColumnValue[]> {
  return call<FormulaColumnValue[]>("evaluate_formula_column", { databaseId, propertyId });
}

// ---- Gamificação ---------------------------------------------------------
//
// Espelha os comandos `#[tauri::command]` de
// `src-tauri/src/ipc/gamificacao_commands.rs` (Fase 1, já mesclada) —
// `xp_total`, `nivel_atual`, `desafios_hoje`, `registrar_xp_desafio_diario`
// e `recordes_pessoais`.
//
// Consolidado aqui a partir de `features/gamificacao/ipc.ts`: aquele arquivo
// nasceu fora deste, com sua própria cópia de `call`/`isAppErrorPayload`,
// porque este módulo era o contrato de outro workflow em paralelo na mesma
// rodada. Sem consolidação, `contrato-ipc.test.ts` — que só lê este
// arquivo — nunca comparava estes tipos contra o Rust. Agora
// `features/gamificacao/ipc.ts` só reexporta o que está aqui.

/**
 * Espelha `EstadoDeNivel` em `src-tauri/src/db/gamificacao.rs`. `progresso`
 * (0.0..=1.0) já vem pronto do backend — a barra de nível lê este campo
 * diretamente, nunca recalcula a fração a partir de
 * `xpNoNivelAtual`/`xpParaProximoNivel` por conta própria (duas contas do
 * mesmo número podem divergir; a regra deste projeto é uma origem só).
 */
export interface EstadoDeNivel {
  nivel: number;
  xpTotal: number;
  xpNoNivelAtual: number;
  xpParaProximoNivel: number;
  progresso: number;
}

/**
 * As três categorias fixas de `CATEGORIAS_DESAFIO` em `db::gamificacao` — a
 * chave que `registrarXpDesafioDiario` manda de volta, nunca traduzida.
 */
export type TipoDesafio = "revisar_cartoes" | "focar_minutos" | "concluir_blocos";

/** Espelha `Desafio` em `src-tauri/src/db/gamificacao.rs`. */
export interface Desafio {
  tipo: TipoDesafio;
  titulo: string;
  unidade: string;
  meta: number;
  /** Calculado no backend a partir do histórico real — nunca um contador à parte. */
  progresso: number;
  concluido: boolean;
  xpRecompensa: number;
  /**
   * `true` quando a XP deste desafio, hoje, já foi creditada. Distinto de
   * `concluido`: dá para estar concluído (`progresso >= meta`) e ainda não
   * creditado, até alguém chamar `registrarXpDesafioDiario`.
   */
  xpCreditado: boolean;
}

/** Espelha `MelhorDia` em `src-tauri/src/db/gamificacao.rs`. */
export interface MelhorDia {
  dia: string;
  revisoes: number;
}

/** Espelha `MelhorSemana` em `src-tauri/src/db/gamificacao.rs`. `semanaInicio` é sempre domingo. */
export interface MelhorSemana {
  semanaInicio: string;
  revisoes: number;
}

/**
 * Espelha `RecordesPessoais` em `src-tauri/src/db/gamificacao.rs` — o que
 * substitui "ranking" nesta tela: nunca uma posição contra outra pessoa,
 * sempre uma marca contra o próprio histórico. `melhorDia`/`melhorSemana` só
 * vêm `null` quando não há nenhuma revisão no histórico.
 */
export interface RecordesPessoais {
  melhorDia: MelhorDia | null;
  maiorSequencia: number;
  melhorSemana: MelhorSemana | null;
}

/** As quatro origens de `xp_events.origin` em `db::gamificacao`. */
export type OrigemXp = "card_review" | "pomodoro_focus" | "cronograma_bloco" | "desafio_diario";

/** Espelha `XpEventRow` em `src-tauri/src/db/gamificacao.rs`. */
export interface XpEventRow {
  id: string;
  amount: number;
  origin: OrigemXp;
  referenceId: string;
  createdAt: string;
  jaCreditado: boolean;
}

/** `xp_total()`: soma de `xp_events` — nunca um contador incrementado à parte. */
export function xpTotal(): Promise<number> {
  return call<number>("xp_total");
}

/** `nivel_atual()`: nível, XP dentro dele e progresso para o próximo. */
export function nivelAtual(): Promise<EstadoDeNivel> {
  return call<EstadoDeNivel>("nivel_atual");
}

/** `desafios_hoje()`: as três categorias do dia local de agora, com progresso já calculado. */
export function desafiosHoje(): Promise<Desafio[]> {
  return call<Desafio[]>("desafios_hoje");
}

/**
 * `registrar_xp_desafio_diario(tipo)`: credita a XP do desafio `tipo` de
 * HOJE. Idempotente no backend (`UNIQUE` em `xp_events`) — chamar de novo
 * para um desafio já creditado devolve a mesma linha, sem duplicar XP.
 */
export function registrarXpDesafioDiario(tipo: TipoDesafio): Promise<XpEventRow> {
  return call<XpEventRow>("registrar_xp_desafio_diario", { tipo });
}

/** `recordes_pessoais()`: melhor dia, maior sequência, melhor semana — derivados do histórico, sem tabela própria. */
export function recordesPessoais(): Promise<RecordesPessoais> {
  return call<RecordesPessoais>("recordes_pessoais");
}

/**
 * Espelha `ResumoDeSessao` em `src-tauri/src/db/gamificacao.rs`: o que
 * aconteceu num intervalo — tipicamente do início ao fim de uma sessão de
 * estudo.
 */
export interface ResumoDeSessao {
  cartoesRevisados: number;
  segundosEstudados: number;
  xpGanho: number;
  /** Reusa `CardRepository::deck_forecast` (dia 1 = amanhã) em vez de reimplementar a previsão de vencimento. */
  cartoesVencendoAmanha: number;
}

/**
 * `resumo_de_sessao(inicio, fim)`: cartões, tempo e XP de um intervalo, e
 * quantos cartões vencem amanhã. `inicio`/`fim` são texto ISO 8601 (RFC 3339)
 * — o backend rejeita texto mal formatado com `AppError` de `kind: "invalid"`.
 */
export function resumoDeSessao(inicio: string, fim: string): Promise<ResumoDeSessao> {
  return call<ResumoDeSessao>("resumo_de_sessao", { inicio, fim });
}

// ---- Prazos ---------------------------------------------------------------
//
// Espelha os comandos `#[tauri::command]` de
// `src-tauri/src/ipc/prazos_commands.rs` (Fase 1, já mesclada) —
// `criar_prazo`, `obter_prazo`, `atualizar_prazo`, `remover_prazo` e
// `listar_prazos`.
//
// Consolidado aqui a partir de `features/prazos/ipc.ts` pela mesma razão
// documentada na seção Gamificação acima: aquele arquivo existia fora deste
// só por causa da separação de workflows em paralelo, com sua própria cópia
// de `call`/`isAppErrorPayload` — e por isso nunca entrava na comparação de
// `contrato-ipc.test.ts`. Agora `features/prazos/ipc.ts` só reexporta o que
// está aqui.

/** Os três estados de `prazos.status` — ver o comentário de `status` em `0027_prazos.sql`. */
export type StatusDoPrazo = "ativo" | "concluido" | "arquivado";

/** Espelha `PrazoRow` em `src-tauri/src/db/prazos.rs`. */
export interface PrazoRow {
  id: string;
  title: string;
  dueLocalDate: string;
  deckId: string | null;
  pageId: string | null;
  status: StatusDoPrazo;
  createdAt: string;
  updatedAt: string;
}

/**
 * Entrada de `atualizarPrazo`. Espelha `PrazoPatchInput` — campo ausente é
 * "sem mudança" (`COALESCE` no backend). **Não existe, através deste patch,
 * como limpar `deckId`/`pageId` de volta para `null` uma vez preenchidos**
 * (mesma limitação documentada no relatório da Fase 1); esta UI não oferece
 * essa opção em vez de fingir que funciona.
 */
export interface PrazoPatchInput {
  title?: string;
  dueLocalDate?: string;
  deckId?: string;
  pageId?: string;
  status?: StatusDoPrazo;
}

/**
 * Espelha `PrazoComContagem` — `PrazoRow` achatado (`#[serde(flatten)]` no
 * Rust) mais `diasRestantes`. Positivo = faltam N dias, zero = é hoje,
 * negativo = venceu há N dias. Só existe dentro de uma `PrazosListados`
 * (nunca calculado no frontend — ver o comentário de `listarPrazos`).
 */
export interface PrazoComContagem extends PrazoRow {
  diasRestantes: number;
}

/** Espelha `PrazosListados`, o retorno de `listarPrazos`. */
export interface PrazosListados {
  /** O dia local (`YYYY-MM-DD`) que o backend usou para classificar vencido/futuro. */
  hoje: string;
  /** `diasRestantes < 0`, do mais recente para o mais antigo. Nunca escondido. */
  vencidos: PrazoComContagem[];
  /** `diasRestantes >= 0`, do mais próximo para o mais distante. */
  futuros: PrazoComContagem[];
}

/** `criar_prazo`. Rejeita título vazio/só-espaço e data mal formatada — o backend valida, este wrapper só expõe o erro. */
export function criarPrazo(
  title: string,
  dueLocalDate: string,
  deckId?: string | null,
  pageId?: string | null,
): Promise<PrazoRow> {
  return call<PrazoRow>("criar_prazo", { title, dueLocalDate, deckId: deckId ?? null, pageId: pageId ?? null });
}

/** `obter_prazo`. Independe de `status` — um prazo concluído/arquivado continua legível por id. */
export function obterPrazo(prazoId: string): Promise<PrazoRow> {
  return call<PrazoRow>("obter_prazo", { prazoId });
}

/** `atualizar_prazo`. Ver a limitação de `deckId`/`pageId` no comentário de `PrazoPatchInput`. */
export function atualizarPrazo(prazoId: string, patch: PrazoPatchInput): Promise<PrazoRow> {
  return call<PrazoRow>("atualizar_prazo", { prazoId, patch });
}

/** `remover_prazo`. Exclusão física, irreversível — `prazos` não tem lixeira própria. */
export function removerPrazo(prazoId: string): Promise<void> {
  return call<void>("remover_prazo", { prazoId });
}

/**
 * `listar_prazos`. Só os prazos `ativo`s, já separados em vencidos/futuros
 * e com `diasRestantes` calculado — nunca recalculado aqui: duas contas de
 * "quantos dias faltam" poderiam divergir na virada do dia (a regra mais
 * forte deste projeto).
 */
export function listarPrazos(): Promise<PrazosListados> {
  return call<PrazosListados>("listar_prazos");
}

// ---------------------------------------------------------------------------
// Finanças — `0043_financas.sql`, `db::financas`, `ipc::financas_commands`.
// Todo valor é CENTAVOS inteiros; mês é `YYYY-MM`; data é `YYYY-MM-DD`.
// ---------------------------------------------------------------------------

/** Quem diz se o dinheiro entra ou sai — o valor é sempre `>= 0`. */
export type TipoFinanceiro = "entrada" | "saida";

/** Espelha `CategoriaRow`. */
export interface CategoriaRow {
  id: string;
  nome: string;
  tipo: TipoFinanceiro;
  ordem: number;
  arquivada: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Espelha `RecorrenteRow`: renda ou gasto fixo, sem o valor (que mora nas vigências). */
export interface RecorrenteRow {
  id: string;
  descricao: string;
  tipo: TipoFinanceiro;
  categoriaId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Espelha `VigenciaRow`: um valor que vale de `inicioMes` até `fimMes` (inclusivo; `null` = sem fim). */
export interface VigenciaRow {
  id: string;
  recorrenteId: string;
  valorCentavos: number;
  inicioMes: string;
  fimMes: string | null;
  createdAt: string;
}

/** Espelha `RecorrenteComVigencias` (`recorrente` vem achatado). Vigências em ordem de `inicioMes`. */
export interface RecorrenteComVigencias extends RecorrenteRow {
  vigencias: VigenciaRow[];
}

/** Espelha `RecorrentePatchInput`. Campo ausente = sem mudança. */
export interface RecorrentePatchInput {
  descricao?: string;
  tipo?: TipoFinanceiro;
  categoriaId?: string;
}

/** Espelha `LancamentoRow`. `recorrenteId`/`mesReferencia` preenchidos = fixo confirmado. */
export interface LancamentoRow {
  id: string;
  dataLocal: string;
  descricao: string;
  tipo: TipoFinanceiro;
  categoriaId: string | null;
  valorCentavos: number;
  recorrenteId: string | null;
  mesReferencia: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Espelha `LancamentoPatchInput`. Campo ausente = sem mudança. */
export interface LancamentoPatchInput {
  dataLocal?: string;
  descricao?: string;
  tipo?: TipoFinanceiro;
  categoriaId?: string;
  valorCentavos?: number;
}

/** Espelha `FixoDoMes`: um recorrente vigente no mês, pendente (`lancamentoId === null`) ou confirmado. */
export interface FixoDoMes {
  recorrenteId: string;
  descricao: string;
  tipo: TipoFinanceiro;
  categoriaId: string | null;
  valorPrevistoCentavos: number;
  lancamentoId: string | null;
  valorConfirmadoCentavos: number | null;
}

/** Espelha `GastoPorCategoria`. `categoriaId === null` = lançamento sem categoria. */
export interface GastoPorCategoria {
  categoriaId: string | null;
  nome: string | null;
  saidasCentavos: number;
}

/** Espelha `LinhaDoMes`. Previsto = fixos vigentes + avulsos; realizado = lançamentos do mês. */
export interface LinhaDoMes {
  mes: string;
  entradasPrevistas: number;
  saidasPrevistas: number;
  entradasRealizadas: number;
  saidasRealizadas: number;
  sobraPrevista: number;
  sobraRealizada: number;
}

/**
 * Espelha `ResumoDoMes`. Toda soma vem do backend — a tela nunca refaz a conta.
 * Campos repetidos de `LinhaDoMes` em vez de `extends`: o Rust não usa
 * `flatten` aqui, e `contrato-ipc.test.ts` compara campo a campo.
 */
export interface ResumoDoMes {
  mes: string;
  entradasPrevistas: number;
  saidasPrevistas: number;
  entradasRealizadas: number;
  saidasRealizadas: number;
  sobraPrevista: number;
  sobraRealizada: number;
  fixos: FixoDoMes[];
  porCategoria: GastoPorCategoria[];
}

/** `listar_categorias_financas`. Não arquivadas; entradas antes das saídas. */
export function listarCategoriasFinancas(): Promise<CategoriaRow[]> {
  return call<CategoriaRow[]>("listar_categorias_financas");
}

/** `criar_categoria_financas`. Nome repetido volta como erro `invalid`. */
export function criarCategoriaFinancas(nome: string, tipo: TipoFinanceiro): Promise<CategoriaRow> {
  return call<CategoriaRow>("criar_categoria_financas", { nome, tipo });
}

/** `criar_recorrente`. Cria o recorrente e a primeira vigência, aberta a partir de `inicioMes`. */
export function criarRecorrente(
  descricao: string,
  tipo: TipoFinanceiro,
  categoriaId: string | null,
  valorCentavos: number,
  inicioMes: string,
): Promise<RecorrenteComVigencias> {
  return call<RecorrenteComVigencias>("criar_recorrente", { descricao, tipo, categoriaId, valorCentavos, inicioMes });
}

/** `listar_recorrentes`. */
export function listarRecorrentes(): Promise<RecorrenteComVigencias[]> {
  return call<RecorrenteComVigencias[]>("listar_recorrentes");
}

/** `atualizar_recorrente`. Devolve o recorrente sem vigências. */
export function atualizarRecorrente(recorrenteId: string, patch: RecorrentePatchInput): Promise<RecorrenteRow> {
  return call<RecorrenteRow>("atualizar_recorrente", { recorrenteId, patch });
}

/** `remover_recorrente`. Apaga as vigências; lançamentos já confirmados ficam, sem vínculo. */
export function removerRecorrente(recorrenteId: string): Promise<void> {
  return call<void>("remover_recorrente", { recorrenteId });
}

/** `mudar_valor_recorrente`. O novo valor vale de `mes` em diante; o anterior fecha no mês de antes. */
export function mudarValorRecorrente(
  recorrenteId: string,
  valorCentavos: number,
  mes: string,
): Promise<RecorrenteComVigencias> {
  return call<RecorrenteComVigencias>("mudar_valor_recorrente", { recorrenteId, valorCentavos, mes });
}

/** `encerrar_recorrente`. `ultimoMes` ainda conta; o mês seguinte não. */
export function encerrarRecorrente(recorrenteId: string, ultimoMes: string): Promise<RecorrenteComVigencias> {
  return call<RecorrenteComVigencias>("encerrar_recorrente", { recorrenteId, ultimoMes });
}

/** `criar_lancamento`. */
export function criarLancamento(
  dataLocal: string,
  descricao: string,
  tipo: TipoFinanceiro,
  categoriaId: string | null,
  valorCentavos: number,
): Promise<LancamentoRow> {
  return call<LancamentoRow>("criar_lancamento", { dataLocal, descricao, tipo, categoriaId, valorCentavos });
}

/** `atualizar_lancamento`. */
export function atualizarLancamento(lancamentoId: string, patch: LancamentoPatchInput): Promise<LancamentoRow> {
  return call<LancamentoRow>("atualizar_lancamento", { lancamentoId, patch });
}

/** `remover_lancamento`. Exclusão física. Remover um fixo confirmado o devolve a pendente. */
export function removerLancamento(lancamentoId: string): Promise<void> {
  return call<void>("remover_lancamento", { lancamentoId });
}

/** `listar_lancamentos_do_mes`. Ordenados por data. */
export function listarLancamentosDoMes(mes: string): Promise<LancamentoRow[]> {
  return call<LancamentoRow[]>("listar_lancamentos_do_mes", { mes });
}

/**
 * `confirmar_recorrente`. Cria o lançamento do fixo no mês. Sem `valorCentavos`
 * usa o valor vigente; sem `dataLocal` usa o dia 1º. Confirmar duas vezes no
 * mesmo mês volta como erro `invalid`.
 */
export function confirmarRecorrente(
  recorrenteId: string,
  mes: string,
  valorCentavos?: number | null,
  dataLocal?: string | null,
): Promise<LancamentoRow> {
  return call<LancamentoRow>("confirmar_recorrente", {
    recorrenteId,
    mes,
    valorCentavos: valorCentavos ?? null,
    dataLocal: dataLocal ?? null,
  });
}

/** `resumo_financeiro_do_mes`. */
export function resumoFinanceiroDoMes(mes: string): Promise<ResumoDoMes> {
  return call<ResumoDoMes>("resumo_financeiro_do_mes", { mes });
}

/** `visao_financeira_por_meses`. `quantidade` de 1 a 36. */
export function visaoFinanceiraPorMeses(inicioMes: string, quantidade: number): Promise<LinhaDoMes[]> {
  return call<LinhaDoMes[]>("visao_financeira_por_meses", { inicioMes, quantidade });
}
