/**
 * A fronteira entre as peças da Fase 3, escrita antes de qualquer uma delas
 * existir — mesmo papel que `src/features/editor/contract.ts` cumpriu na
 * Fase 2. Ver `docs/FASE-3-ARQUITETURA.md` (o contrato) e
 * `docs/FASE-3-SCHEMA.sql` (o DDL); quando este arquivo e uma migração
 * discordarem, a migração vence.
 *
 * Este arquivo é deliberadamente types-only. Diz o que uma database, uma
 * propriedade, uma view e um valor DE REGISTRO são, e o vocabulário fechado
 * (`ValueShape`, `FilterOperator`, `AggregationKind`) sobre o qual o Rust
 * traduz SQL. Não diz como um tipo de propriedade concreto renderiza, edita
 * ou agrega — isso é `core/property-spec.ts`, o ponto de extensão, no mesmo
 * espírito de `core/block-spec.ts` na Fase 2.
 *
 * As formas espelham as tabelas de `docs/FASE-3-SCHEMA.sql` mais
 * `0007_databases.sql` / `0008_database_properties_views.sql` /
 * `0009_database_record_values.sql`, campo a campo.
 */

/** Id gerado no servidor. Apelidado para nunca confundir com PageId/ViewId. */
export type DatabaseId = string;
export type PropertyId = string;
export type ViewId = string;
export type OptionId = string;
/** Um registro É uma página (`pages.database_id`), então RecordId == PageId. */
export type RecordId = string;
export type TemplateId = RecordId;
/**
 * Página comum — não necessariamente um registro. É o que
 * `databases.container_page_id` referencia: a página que HOSPEDA a
 * database, seja inteira (DBS-001) ou como um bloco dentro dela (DBS-002).
 */
export type PageId = string;

/**
 * O jsonb de `database_record_values.value`. Opaco fora do spec do tipo —
 * só `PropertySpec.parse`/`serialize`/`normalize` (em `core/property-spec.ts`)
 * sabem o que fazer com um valor concreto.
 */
export type PropertyValue = unknown;

/**
 * O conjunto FECHADO sobre o qual o Rust traduz SQL (arquitetura §6). Um
 * tipo de propriedade novo (email, telefone) ESCOLHE uma destas formas; não
 * inventa uma. O tradutor em Rust faz `match` sobre `ValueShape`, nunca sobre
 * `property_type` — é o que permite a Fase 6 acrescentar tipo sem tocar em
 * migração nem em `predicate.rs`.
 */
export type ValueShape =
  | "text" // string jsonb nua
  | "number" // número jsonb nu
  | "boolean" // `true` nu (false NUNCA é gravado por um checkbox — I1; formula booleana é a exceção nomeada)
  | "option" // string = id da opção, NUNCA o rótulo
  | "option_list" // array de ids de opção
  | "date" // DateValue
  | "person" // PersonValue
  | "file_list" // array de FileRef
  | "timestamp"; // virtual: lido de colunas de `pages` (created_time/last_edited_time), sem linha própria

/**
 * I5: ISO de largura fixa, hora local de parede. Sem fuso, sem segundos.
 * `includeTime`/`hasEnd` moram na CONFIG da propriedade, nunca aqui — o
 * valor não pode dizer se `end` "existe mas está oculto".
 */
export interface DateValue {
  /** "YYYY-MM-DD" ou "YYYY-MM-DDTHH:mm". */
  start: string;
  /** Mesma largura de `start`. */
  end?: string | null;
}

/** DBS-082/083/120. Contato local: não há conta, login nem perfil — I5 do escopo da fase. */
export interface PersonValue {
  name: string;
  email: string | null;
}

export interface FileRef {
  id: string;
  /** Exatamente o que `storeMediaFile()` (editor) devolve — hash SHA-256. REUSAR, não reinventar. */
  src: string;
  name: string;
  kind: "image" | "video" | "audio" | "file";
}

/** Tabela="grid", Board="card", Lista="row", peek/página="peek". Muda truncamento e rótulo, nunca o renderizador. */
export type CellDensity = "grid" | "card" | "row" | "peek";

export type FilterOperator =
  | "is"
  | "isNot"
  | "contains"
  | "doesNotContain"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isBefore"
  | "isAfter"
  | "isOnOrBefore"
  | "isOnOrAfter"
  | "isWithin"
  | "isChecked"
  | "isNotChecked"
  | "isEmpty"
  | "isNotEmpty"
  | "containsAny"
  | "containsAll";

export type AggregationKind =
  | "count_all"
  | "count_values"
  | "count_unique"
  | "count_empty"
  | "count_not_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "earliest_date"
  | "latest_date"
  | "date_range";

/**
 * Linha de `databases` (`0007_databases.sql` + `data_version` e `config` de
 * `docs/FASE-3-SCHEMA.sql`, itens (7) de 0017 e 0020).
 */
export interface Database {
  id: DatabaseId;
  containerPageId: PageId;
  name: string;
  /** DBS-002: bloqueia estrutura (propriedade/view), nunca valor. */
  isLocked: boolean;
  /**
   * Blob lido/escrito inteiro (decisão (d) da fundação — nenhuma consulta do
   * pipeline olha dentro dele). Forma esperada, por
   * `docs/FASE-3-SCHEMA.sql` (0020): `{ subItems, dependencies,
   * defaultTemplateId }` — não tipada aqui porque nenhuma peça desta rodada
   * ainda lê/escreve um sub-campo específico; ver divergência N1 no relatório.
   */
  config: Record<string, unknown>;
  /**
   * Sobe a cada INSERT/UPDATE/DELETE em `database_record_values` desta
   * database (gatilho de 0017, por STATEMENT). Invalida
   * `ViewQueryHandle.dataVersion` no pipeline de consulta — token vencido
   * vira `Error::Invalid`, cliente reabre.
   */
  dataVersion: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Linha de `database_properties` (`0008_database_properties_views.sql`).
 * `propertyType` é vocabulário ABERTO (texto, não enum) de propósito — a
 * Fase 6 acrescenta tipo sem migração de enum. O spec dono de um tipo mora
 * no registro de `core/property-spec.ts`, indexado por este mesmo texto.
 */
export interface DatabaseProperty {
  id: PropertyId;
  databaseId: DatabaseId;
  name: string;
  propertyType: string;
  /** Forma depende de `propertyType`; ver `PropertySpec.defaultConfig` no registro. */
  config: Record<string, unknown>;
  /** Índice fracionário entre irmãs — mesma técnica de `Block.position`. */
  position: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Linha de `database_views` (`0008_database_properties_views.sql`).
 * `viewType` é vocabulário aberto pela mesma razão de `propertyType`; o
 * registro de `core/view-spec.ts` cobre `table`/`board`/`list`/`calendar`
 * nesta fase.
 */
export interface DatabaseView {
  id: ViewId;
  databaseId: DatabaseId;
  name: string;
  viewType: string;
  /**
   * Blob lido/escrito inteiro (DBS-053). A forma completa (`filter`, `sorts`,
   * `group`, `colorRules`, `columnOrder`, ...) é do pipeline de consulta —
   * arquitetura §8 a atribui a `src/features/databases/query/contract.ts`,
   * arquivo de outra peça que não existe nesta rodada. Ver divergência N1.
   */
  config: Record<string, unknown>;
  position: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Linha de `database_record_values` PÓS-0017 (a PK deixou de ser sintética;
 * `sort_num`/`sort_text`/`stale_after` são colunas GERADAS pelo Postgres).
 *
 * I1: a AUSÊNCIA de uma linha (record_id, property_id) É o vazio. Não existe
 * `RecordValue` "vazio" — `value` nunca é `'null'::jsonb`, `""`, `[]` nem
 * `{}` (CHECK `chk_drv_never_empty`). `false` é a exceção nomeada (fórmula
 * booleana).
 *
 * I2: NUNCA ordene por `value` — jsonb compara por quantidade de chaves
 * antes do conteúdo. Ordene por `sortNum`/`sortText`.
 *
 * I3: toda condição sobre `sortText` sai em PAR com `value` (truncamento em
 * 256). Só `src-tauri/src/db/query/predicate.rs` pode emitir esse SQL.
 */
export interface RecordValue {
  recordId: RecordId;
  propertyId: PropertyId;
  value: PropertyValue;
  /**
   * Gerada. Não-nulo só quando `jsonb_typeof(value)` é `number` ou
   * `boolean`. NUNCA escrita pelo cliente — é `readonly` de propósito.
   */
  readonly sortNum: number | null;
  /**
   * Gerada, truncada em 256 caracteres (I3). NUNCA escrita pelo cliente.
   */
  readonly sortText: string | null;
  /**
   * Instante em que este valor pode mudar sozinho pela passagem do tempo
   * (fórmula lendo `now()`/`today()`). `null` = nunca, o caso de quase toda
   * linha. A varredura preguiçosa lê esta coluna e enfileira em
   * `derived_value_queue` (0019) — não é um segundo mecanismo de
   * invalidação.
   */
  readonly staleAfter: string | null;
  updatedAt: string;
}

/**
 * DIVERGÊNCIA (ver `divergencias_da_arquitetura` no relatório desta peça): a
 * §8 da arquitetura atribui `RecordRow` a `src/features/databases/query/contract.ts`,
 * arquivo de outra peça (Q, no fan-out da Fase B) que ainda não existe nesta
 * rodada. `PropertySpec.renderValue`/`renderEditor` (em `core/property-spec.ts`)
 * precisam da forma de um registro para `CellRenderContext`/`CellEditContext`,
 * então ela é declarada aqui, campo a campo igual à §8 — a peça dona de
 * `query/contract.ts` deve IMPORTAR este tipo em vez de redeclará-lo. Duas
 * declarações do mesmo formato em arquivos diferentes divergem na primeira
 * propriedade nova que uma esquecer, e ninguém avisa.
 */
export interface RecordRow {
  id: RecordId;
  title: string;
  icon: string | null;
  /** DBS-118 (sub-itens). */
  parentId: RecordId | null;
  position: string;
  createdAt: string;
  updatedAt: string;
  /** Propriedade AUSENTE do mapa == vazia (I1). Não existe `null` explícito aqui. */
  values: Record<PropertyId, PropertyValue>;
  /** DBS-120, avaliado no Postgres. O cliente só pinta. */
  matchedColorRuleIds: string[];
}
