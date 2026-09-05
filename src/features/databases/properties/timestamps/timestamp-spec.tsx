/**
 * `created_time`/`last_edited_time` — DBS-024/026. Os dois compartilham tudo
 * menos QUAL coluna de `pages` projetam (`created_at` vs `updated_at`), daí
 * a fábrica única abaixo em vez de duas cópias quase idênticas.
 *
 * Ponto central do desenho (arquitetura §6): esta propriedade NÃO tem linha
 * em `database_record_values` — "criado em"/"editado em" vêm de colunas de
 * `pages` que `RecordRow` já expõe direto (`contract.ts`, comentado
 * "alimenta DBS-024"/"alimenta DBS-026"). Por isso `renderValue` abaixo lê
 * `ctx.record` e ignora `ctx.value`: depender de `ctx.value` presumiria que
 * o pipeline de consulta (peça Q, fora deste escopo) projeta esse instante
 * dentro de `values[propertyId]` — uma promessa que a arquitetura não faz
 * (o comentário do campo aponta para `RecordRow`, não para o mapa). Ler
 * `record` direto funciona não importa como aquele pipeline vier a existir.
 */
import type { DateValue, RecordRow } from "../../contract";
import type { CellRenderContext, PropertySpec } from "../../core/property-spec";
import { DEFAULT_TIMESTAMP_CONFIG, formatTimestampPlainText, parseInstantToLocalDateValue, type TimestampConfig } from "./format";

interface TimestampSpecOptions {
  type: "created_time" | "last_edited_time";
  label: string;
  icon: string;
  /** `record.createdAt` para "Criado em", `record.updatedAt` para "Editado em" — DBS-026 é o gatilho `touch_record_from_value` de `0017_database_value_invariants.sql`, que avança `pages.updated_at` a cada INSERT/UPDATE/DELETE em `database_record_values` desse registro; este spec só CONSOME o valor já projetado, não o produz. */
  pickInstant(record: RecordRow): string;
}

function renderTimestampCell(
  { record, property }: CellRenderContext<DateValue, TimestampConfig>,
  pickInstant: (record: RecordRow) => string,
) {
  const value = parseInstantToLocalDateValue(pickInstant(record));
  const text = formatTimestampPlainText(value, property.config);
  // `dateTime` só quando o instante é válido — um `<time>` com atributo
  // vazio é pior que omiti-lo (leitor de tela leria "tempo vazio").
  return <time dateTime={value.start === "" ? undefined : value.start}>{text === "" ? "—" : text}</time>;
}

function createTimestampSpec({ type, label, icon, pickInstant }: TimestampSpecOptions): PropertySpec<DateValue, TimestampConfig> {
  return {
    type,
    label,
    icon,
    valueShape: "timestamp",
    defaultConfig: DEFAULT_TIMESTAMP_CONFIG,
    // I1 não se aplica aqui do jeito usual: não existe linha para faltar.
    // Toda página tem `created_at`/`updated_at` (`NOT NULL` no schema de
    // `0003_pages.sql`) — "Criado em"/"Editado em" NUNCA são vazios de
    // verdade, então `isEmpty` ignora `value` de propósito em vez de tratar
    // a ausência do mapa `values` (que É esperada para este tipo) como
    // vazio.
    isEmpty: () => false,
    // Sempre recusa gravar (DBS-024: "a célula é somente-leitura"). Defesa
    // em profundidade: sem `renderEditor`, a UI nunca chama `commit()` para
    // este tipo — mas se algum caminho futuro tentar, `normalize` que
    // devolve `null` faz I4 apagar em vez de criar a linha que a
    // arquitetura proíbe para este `valueShape` (§6: "NÃO têm linha").
    normalize: () => null,
    parse: parseInstantToLocalDateValue,
    serialize: (value) => value,
    renderValue: (ctx) => renderTimestampCell(ctx, pickInstant),
    // Sem "isEmpty"/"isNotEmpty": nunca vazio (ver `isEmpty` acima), então
    // os dois operadores nunca teriam um resultado que não seja trivial.
    filterOperators: ["isBefore", "isAfter", "isOnOrBefore", "isOnOrAfter", "isWithin"],
    // ISO de largura fixa (I5) ordena lexicograficamente = cronologicamente.
    sort: "text",
    grouping: { strategy: "date_bucket" },
    aggregations: ["earliest_date", "latest_date", "date_range"],
    toPlainText: (value, config) => (value ? formatTimestampPlainText(value, config) : ""),
  };
}

export const createdTimePropertySpec: PropertySpec<DateValue, TimestampConfig> = createTimestampSpec({
  type: "created_time",
  label: "Criado em",
  icon: "🕓",
  pickInstant: (record) => record.createdAt,
});

export const lastEditedTimePropertySpec: PropertySpec<DateValue, TimestampConfig> = createTimestampSpec({
  type: "last_edited_time",
  label: "Editado em",
  icon: "🕓",
  pickInstant: (record) => record.updatedAt,
});
