/**
 * DBS-004 — o valor de uma célula de Texto: um pequeno array de nós inline
 * (texto com marcas + quebras de linha), sem blocos aninhados (arquitetura
 * §6, nota "text"). Este arquivo é a metade pura — sem React, sem TipTap
 * `Editor` — do tipo de propriedade; `register.ts` monta o `PropertySpec`
 * em cima destas funções, e `RichTextCell.tsx`/`RichTextEditor.tsx` são as
 * únicas outras coisas que a leem.
 *
 * ## Por que o jsonb persistido é uma STRING, nunca um objeto
 *
 * `ValueShape.text` é "string jsonb nua" (`contract.ts`), e o fixture
 * compartilhado `src-tauri/tests/fixtures/property_values.json` (caso
 * `text_valid_short`) confirma isso na prática: `value` para
 * `propertyType: "text"` é `"Anotação da Fase 3"`, um texto puro — não
 * `{ text: "...", inline: [...] }`. A coluna gerada `sort_text` de `0017`
 * concorda: para `jsonb_typeof(value) = 'string'` ela usa `value` inteiro.
 *
 * Isso deixa pouco espaço para preservar marca (negrito) dentro do valor:
 * a solução aqui é que, na AUSÊNCIA de qualquer marca, a string persistida
 * É o texto achatado (rápido, legível, e o que `sort_text`/busca/CSV
 * enxergam) — é exatamente o caso comum e o caso do fixture. Só quando
 * alguma marca está presente é que a string ganha um prefixo invisível
 * (impossível de digitar por teclado) seguido do JSON canônico dos nós —
 * a única forma de guardar negrito/itálico/etc. dentro de uma ÚNICA string
 * jsonb sem uma segunda coluna. Ordenação/busca sobre texto COM marca fica
 * imprecisa (o JSON aparece no meio) — aceito, documentado, e fora do
 * alcance desta peça: `predicate.rs` (outra peça, Q) é quem decide o que
 * fazer com isso na consulta.
 */

/** As seis marcas que a célula suporta — ver `RichTextEditor.tsx`. */
export type InlineMarkType = "bold" | "italic" | "strike" | "underline" | "code" | "link";

export interface InlineMark {
  type: InlineMarkType;
  /** Só `link` usa. */
  attrs?: { href?: string };
}

export interface InlineTextNode {
  type: "text";
  text: string;
  marks?: InlineMark[];
}

export interface InlineBreakNode {
  type: "hardBreak";
}

export type RichTextNode = InlineTextNode | InlineBreakNode;

/** O `TValue` do `PropertySpec<RichTextValue, RichTextConfig>`. */
export type RichTextValue = RichTextNode[];

/** Texto não tem opção nem formato — a config existe só para a assinatura genérica de `PropertySpec` bater. */
export type RichTextConfig = Record<string, never>;

/**
 * Ordem canônica de aplicação de marca — fixa, para que duas passagens pelo
 * mesmo conteúdo sempre produzam o mesmo JSON serializado (essencial para
 * `mergeAdjacentTextNodes` comparar marcas por posição, e para round trips
 * serem estáveis byte a byte).
 */
const MARK_ORDER: readonly InlineMarkType[] = ["link", "bold", "italic", "underline", "strike", "code"];

function isKnownMarkType(type: unknown): type is InlineMarkType {
  return (
    type === "bold" ||
    type === "italic" ||
    type === "strike" ||
    type === "underline" ||
    type === "code" ||
    type === "link"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * TOTAL: qualquer entrada que não seja um array de marca reconhecível vira
 * `[]`, nunca lança. Um `href` ausente ou vazio derruba a marca `link`
 * inteira — um link sem destino não é um link.
 */
function sanitizeMarkArray(raw: unknown): InlineMark[] {
  if (!Array.isArray(raw)) return [];
  const collected = new Map<InlineMarkType, InlineMark>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const type = entry.type;
    if (!isKnownMarkType(type)) continue;
    if (type === "link") {
      const attrs = isRecord(entry.attrs) ? entry.attrs : {};
      const href = typeof attrs.href === "string" ? attrs.href : "";
      if (href.length === 0) continue;
      collected.set(type, { type, attrs: { href } });
    } else {
      collected.set(type, { type });
    }
  }
  const ordered: InlineMark[] = [];
  for (const markType of MARK_ORDER) {
    const found = collected.get(markType);
    if (found) ordered.push(found);
  }
  return ordered;
}

function marksEqual(a: readonly InlineMark[], b: readonly InlineMark[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((mark, index) => {
    const other = b[index];
    if (mark.type !== other.type) return false;
    if (mark.type === "link") return mark.attrs?.href === other.attrs?.href;
    return true;
  });
}

/** Nós consecutivos de texto com a MESMA marca viram um só — o que uma sessão de digitação comum produz (letra a letra) e o que garante que codificar duas vezes o mesmo conteúdo dê a mesma string. */
function mergeAdjacentTextNodes(nodes: readonly RichTextNode[]): RichTextNode[] {
  const merged: RichTextNode[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (previous && previous.type === "text" && node.type === "text" && marksEqual(previous.marks ?? [], node.marks ?? [])) {
      previous.text += node.text;
      continue;
    }
    merged.push(node.type === "text" ? { ...node } : node);
  }
  return merged;
}

function sanitizeNode(raw: unknown): RichTextNode | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "hardBreak") return { type: "hardBreak" };
  if (raw.type === "text" && typeof raw.text === "string" && raw.text.length > 0) {
    const marks = sanitizeMarkArray(raw.marks);
    return marks.length > 0 ? { type: "text", text: raw.text, marks } : { type: "text", text: raw.text };
  }
  return null;
}

/**
 * TOTAL — a porta de entrada de qualquer valor não confiável (o `getJSON()`
 * de um editor real, um CSV importado, um jsonb lido de volta): nunca
 * lança, nunca deixa passar um tipo de nó ou de marca que este arquivo não
 * conhece. Usada por `normalize`, `isEmpty`, `encodeRichText` e
 * `decodeRichText` — o único lugar que decide "isto conta como um nó
 * válido".
 */
export function sanitizeNodes(raw: unknown): RichTextValue {
  if (!Array.isArray(raw)) return [];
  const nodes: RichTextNode[] = [];
  for (const item of raw) {
    const node = sanitizeNode(item);
    if (node) nodes.push(node);
  }
  return mergeAdjacentTextNodes(nodes);
}

/**
 * O achatador desta propriedade. Não delega a `inlinePlainTextFor`
 * (`src/features/editor`, registro de átomos inline do editor de blocos)
 * porque `RichTextNode` é um union FECHADO de só dois tipos — texto e
 * hardBreak — sem espaço para um átomo (menção, equação) que aquele
 * registro existiria para ler; `sanitizeNodes` já descarta qualquer coisa
 * fora desses dois tipos antes de chegar aqui. Ver `divergencias_da_arquitetura`
 * no relatório desta peça para o porquê disto não reusa o achatador do
 * editor de blocos.
 */
export function flattenPlainText(nodes: RichTextValue | null | undefined): string {
  if (!nodes) return "";
  let text = "";
  for (const node of nodes) {
    text += node.type === "hardBreak" ? "\n" : node.text;
  }
  return text;
}

/** I1 aplicada ao Texto: vazio é a ausência de qualquer caractere achatado — nunca `value === null` por si só (um array com só uma marca sem texto não existe, `sanitizeNode` já recusa nó de texto vazio). */
export function isEmptyRichTextValue(value: unknown): boolean {
  return flattenPlainText(sanitizeNodes(value)).length === 0;
}

/** `PropertySpec.normalize` — devolve `null` (I1: apaga a linha) quando o achatado é vazio. */
export function normalizeRichTextValue(value: unknown): RichTextValue | null {
  const nodes = sanitizeNodes(value);
  return flattenPlainText(nodes).length === 0 ? null : nodes;
}

/** Separador invisível (U+2063, INVISIBLE SEPARATOR) — não alcançável por nenhum teclado/IME padrão, então uma string digitada de verdade nunca começa com ele. Ver o cabeçalho do arquivo para o porquê deste prefixo existir. */
export const RICH_TEXT_MARKER = "⁣tiptap-rich-text-v1⁣";

function hasFormatting(nodes: RichTextValue): boolean {
  return nodes.some((node) => node.type === "text" && (node.marks?.length ?? 0) > 0);
}

/**
 * `PropertySpec.serialize` — o jsonb (sempre uma string) que vai para
 * `database_record_values.value`. Sem marca: a própria string achatada
 * (caminho rápido, o caso do fixture). Com marca: prefixo + JSON canônico.
 */
export function encodeRichText(value: RichTextValue): string {
  const nodes = sanitizeNodes(value);
  if (!hasFormatting(nodes)) return flattenPlainText(nodes);
  return RICH_TEXT_MARKER + JSON.stringify(nodes);
}

/** Uma string sem marcação vira uma sequência de nós de texto separados por `hardBreak` em cada `\n` — o inverso de `flattenPlainText` para conteúdo sem marca. */
export function wrapPlainText(text: string): RichTextValue {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  const nodes: RichTextValue = [];
  lines.forEach((line, index) => {
    if (line.length > 0) nodes.push({ type: "text", text: line });
    if (index < lines.length - 1) nodes.push({ type: "hardBreak" });
  });
  return nodes;
}

/**
 * `PropertySpec.parse` — TOTAL, nunca lança. Um valor corrompido (marcador
 * presente mas JSON quebrado, ou tipo que não é string) vira vazio, nunca
 * garante mostrar o lixo na tela.
 */
export function decodeRichText(raw: unknown): RichTextValue {
  if (typeof raw !== "string") return [];
  if (raw.startsWith(RICH_TEXT_MARKER)) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(RICH_TEXT_MARKER.length));
      return sanitizeNodes(parsed);
    } catch {
      return [];
    }
  }
  return wrapPlainText(raw);
}
