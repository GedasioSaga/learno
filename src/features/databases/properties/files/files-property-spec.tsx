/**
 * `PropertySpec` do tipo "files" (Arquivo e mídia, DBS-016) — anexa um ou
 * mais arquivos/imagens a um registro, reordenáveis por arrasto. O byte em
 * si é `storeMediaFile`/`resolveMediaSrc` do editor
 * (`editor/blocks/media/media-storage.ts`), REUSADO — esta pasta nunca grava
 * disco por conta própria. Ver ACHADOS-FASE-2 (item 1) sobre o gap de
 * `fs:scope` com pasta de dados customizada: esta peça HERDA esse limite ao
 * reusar o storage, e consertá-lo é fora do escopo desta peça (ver relatório
 * — `divergencias_da_arquitetura`).
 *
 * Este arquivo não chama `registerPropertySpec` — quem faz isso é
 * `register.ts`, o único arquivo que `discover-extensions.ts` importa.
 */
import type { FileRef } from "../../contract";
import type { PropertySpec } from "../../core/property-spec";
import { FilesCell } from "./FilesCell";
import { FilesEditor } from "./FilesEditor";

export const FILES_PROPERTY_TYPE = "files";

/** Sem campo nenhum hoje — YAGNI: nenhum item do checklist desta rodada pede configuração (limite de itens, tipo aceito) para esta propriedade. */
export type FilesPropertyConfig = Record<string, never>;

function isFileRefShape(candidate: unknown): candidate is FileRef {
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as Record<string, unknown>;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.src === "string" &&
    value.src.length > 0 &&
    typeof value.name === "string" &&
    (value.kind === "image" || value.kind === "video" || value.kind === "audio" || value.kind === "file")
  );
}

/** jsonb -> FileRef[]. TOTAL: item corrompido é descartado, nunca lança — uma célula não pode derrubar a view (contrato de `parse`). */
function parseFiles(raw: unknown): FileRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFileRefShape);
}

/**
 * Canoniza antes de gravar (I1): uma lista sem nenhum item válido devolve
 * `null` — APAGA a linha, exatamente como um multi-select vazio. Um item
 * inválido isolado é descartado em vez de recusar a escrita inteira: quem
 * monta a lista de verdade é sempre `FilesEditor` (que só produz `FileRef`
 * válido); "inválido" só aconteceria se outra fonte gravasse algo torto.
 */
function normalizeFiles(value: unknown): FileRef[] | null {
  if (!Array.isArray(value)) return null;
  const valid = value.filter(isFileRefShape);
  return valid.length > 0 ? valid : null;
}

export const filesPropertySpec: PropertySpec<FileRef[], FilesPropertyConfig> = {
  type: FILES_PROPERTY_TYPE,
  label: "Arquivo e mídia",
  icon: "📎",

  valueShape: "file_list",
  defaultConfig: {},

  // I1 aplicada aqui: `null`/`undefined`/`[]` são vazios; uma lista com pelo
  // menos um `FileRef` nunca é — não existe "arquivo vazio" intermediário.
  isEmpty: (value) => value === null || value === undefined || (Array.isArray(value) && value.length === 0),
  normalize: (value) => normalizeFiles(value),
  parse: (raw) => parseFiles(raw),
  serialize: (value) => value,

  renderValue: (ctx) => <FilesCell value={ctx.value} density={ctx.density} />,
  renderEditor: (ctx) => <FilesEditor value={ctx.value} onCommit={ctx.commit} />,

  // Só presença/ausência faz sentido filtrar numa lista de anexos — não há
  // "contém texto" nem comparação de valor por cima de um array de objetos.
  filterOperators: ["isEmpty", "isNotEmpty"],
  // "none": arquivo é explicitamente NÃO-ordenável por valor (arquitetura §6,
  // nota do tipo `PropertySpec.sort` — mesmo grupo de relation/button).
  sort: "none",
  // Só contagens estruturais (presença de linha) — nada aqui depende de
  // interpretar o CONTEÚDO de um `FileRef`, então nenhuma agregação
  // numérica/de data se aplica.
  aggregations: ["count_all", "count_values", "count_empty", "count_not_empty", "percent_empty", "percent_not_empty"],

  toPlainText: (value) => (value && value.length > 0 ? value.map((file) => file.name).join(", ") : ""),
  // Sem `parsePlainText`: não há como materializar o BYTE de um arquivo a
  // partir de um nome de texto colado ou de uma célula de CSV — permanece
  // editor-only, ao contrário de select/número/data.
};
