import { invoke } from "@tauri-apps/api/core";

/**
 * Espelha `AppConfig` em `src-tauri/src/config/mod.rs`. Nunca tem senha — o
 * backend nunca persiste uma, então este tipo nunca precisa carregar uma.
 * Uma sessão com `AppConfig` salvo mas que ainda não chamou `connectDatabase`
 * nesta execução do processo não tem conexão nenhuma: ver `needs-reconnect`
 * em `App.tsx`.
 */
export interface AppConfig {
  host: string;
  port: number;
  database: string;
  user: string;
}

/** Espelha `ConnectionTestInput` em `src-tauri/src/config/mod.rs`. */
export interface ConnectionTestInput {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
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

/** `null` quando o assistente de primeira execução ainda não rodou. */
export function getAppConfig(): Promise<AppConfig | null> {
  return call<AppConfig | null>("get_app_config");
}

export function testDatabaseConnection(input: ConnectionTestInput): Promise<void> {
  return call<void>("test_database_connection", { input });
}

/**
 * Conecta de verdade ao Postgres informado, aplica as migrações pendentes e
 * só então persiste a configuração (sem a senha) — chamado quando o
 * assistente de primeira execução termina, e de novo sempre que o app abre
 * com uma configuração salva mas a sessão ainda não tem conexão (a senha
 * nunca é persistida, então precisa ser digitada de novo a cada abertura).
 * Devolve a `AppConfig` persistida para o chamador atualizar seu estado.
 */
export function connectDatabase(input: ConnectionTestInput): Promise<AppConfig> {
  return call<AppConfig>("connect_database", { input });
}

/**
 * PLT-016: pasta de dados coletada pelo assistente de primeira execução.
 * `null` quando nada foi salvo ainda — o backend cai para o padrão do SO
 * (`app_data_dir()`) nesse caso.
 */
export function getDataDir(): Promise<string | null> {
  return call<string | null>("get_data_dir");
}

/** PLT-016: persiste a pasta de dados. Rejeita string vazia/só espaço. */
export function saveDataDir(dataDir: string): Promise<void> {
  return call<void>("save_data_dir", { dataDir });
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
 * PLT-011: dispara um `pg_dump` real contra o Postgres configurado. A senha
 * nunca é persistida — só vive na memória desta chamada. Devolve o caminho
 * do arquivo de dump criado.
 */
export function createBackup(password: string, outputDir: string): Promise<string> {
  return call<string>("create_backup", { password, outputDir });
}

/** PLT-011: restaura um dump gerado por `createBackup` (ou qualquer `pg_dump -Fc`) sobre o banco configurado. */
export function restoreBackup(password: string, dumpPath: string): Promise<void> {
  return call<void>("restore_backup", { password, dumpPath });
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
export function runDueScheduledBackup(password: string): Promise<string | null> {
  return call<string | null>("run_due_scheduled_backup", { password });
}

/**
 * PLT-013: cria um backup automático imediatamente, marcado como disparado
 * por uma operação de risco (`operation` é um rótulo livre, ex.:
 * `"import_colpkg"`) — independente da cadência configurada, e prunado pela
 * sua própria retenção.
 */
export function triggerBackupForRiskyOperation(password: string, operation: string): Promise<string> {
  return call<string>("trigger_backup_for_risky_operation", { password, operation });
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
 * já têm código real por trás (o reparo apaga linha) — `password` existe só
 * para que o backend consiga fazer uma cópia de segurança antes de reparar,
 * nunca persistida, igual a `createBackup`/`restoreBackup` acima. Se o
 * backup em si falhar (pg_dump ausente, disco cheio), o reparo nem chega a
 * rodar — o erro que volta aqui já descreve o motivo.
 */
export function checkDatabase(password: string): Promise<IntegrityReport> {
  return call<IntegrityReport>("check_database", { password });
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
 * código real por trás — um import pode sobrescrever cartões existentes.
 * `password` segue a mesma regra de `checkDatabase`/`createBackup`: nunca
 * persistida, só usada para o backup automático que roda antes do sidecar
 * ser chamado. Um backup que falhar aborta o import inteiro — o `kind` do
 * erro (`"config"` para `pg_dump` ausente, `"invalid"` para disco cheio ou
 * timeout) chega aqui igual a qualquer outro erro deste módulo.
 */
export function importApkg(path: string, password: string): Promise<ApkgImportResult> {
  return call<ApkgImportResult>("import_apkg", { path, password });
}

/**
 * Nome do evento que o item "Alternar tema" do menu nativo emite — tem que
 * ser exatamente igual à constante `TOGGLE_THEME_EVENT` em `src-tauri/src/lib.rs`.
 */
export const TOGGLE_THEME_EVENT = "learno://toggle-theme";
