/**
 * A lógica PURA do editor de fórmula (`FormulaConfigForm.tsx`): inserir no
 * cursor, converter posição em linha/coluna, agrupar e filtrar a paleta.
 * Sem React e sem IPC, para ser testável em isolamento — o mesmo corte de
 * `date-value.ts` e `number-spec.ts`.
 *
 * Toda posição aqui é em unidades UTF-16 (o índice de `string` do
 * JavaScript), que é exatamente o que `validate_formula` já devolve em
 * `DiagnosticDto.start/end` — o Rust converte de bytes na fronteira
 * (`byte_span_to_utf16`), então nenhuma conversão acontece deste lado.
 */
import type { FormulaFunctionDoc } from "../../../../lib/ipc";
import type { PropertyDescriptor } from "../../core/property-spec";

export interface Insertion {
  next: string;
  /** Onde o cursor fica depois da inserção. */
  caret: number;
}

/**
 * Insere `name(...)` na seleção atual. Com seleção vazia, o cursor fica
 * ENTRE os parênteses, pronto para o primeiro argumento; com texto
 * selecionado, ele vira o argumento e o cursor fica depois do `)`.
 */
export function insertFunctionCall(expression: string, selectionStart: number, selectionEnd: number, name: string): Insertion {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  const selected = expression.slice(start, end);
  const before = expression.slice(0, start);
  const after = expression.slice(end);
  const call = `${name}(${selected})`;
  const caret = selected.length === 0 ? start + name.length + 1 : start + call.length;
  return { next: `${before}${call}${after}`, caret };
}

/** Insere `prop("Nome")` na seleção atual (substituindo o que estava selecionado); o cursor fica depois do `)`. */
export function insertPropertyReference(expression: string, selectionStart: number, selectionEnd: number, propertyName: string): Insertion {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  const reference = `prop("${propertyName}")`;
  return { next: `${expression.slice(0, start)}${reference}${expression.slice(end)}`, caret: start + reference.length };
}

export interface LineAndColumn {
  /** 1-based. */
  line: number;
  /** 1-based, em unidades UTF-16. */
  column: number;
}

/** Posição (unidades UTF-16) -> linha/coluna, para a mensagem "linha 2, coluna 7". Fora do texto, gruda no fim. */
export function lineAndColumn(expression: string, offset: number): LineAndColumn {
  const clamped = Math.max(0, Math.min(offset, expression.length));
  const before = expression.slice(0, clamped);
  const lastBreak = before.lastIndexOf("\n");
  const line = before.split("\n").length;
  const column = clamped - (lastBreak + 1) + 1;
  return { line, column };
}

export interface FunctionGroup {
  category: string;
  functions: FormulaFunctionDoc[];
}

/**
 * Agrupa por categoria NA ORDEM em que o Rust as devolve (matemática,
 * agregação, texto, data, lógica) — não alfabética: a ordem de registro é
 * a ordem didática, e reordenar aqui seria uma segunda opinião.
 */
export function groupFunctionsByCategory(docs: readonly FormulaFunctionDoc[]): FunctionGroup[] {
  const groups: FunctionGroup[] = [];
  for (const doc of docs) {
    let group = groups.find((candidate) => candidate.category === doc.category);
    if (!group) {
      group = { category: doc.category, functions: [] };
      groups.push(group);
    }
    group.functions.push(doc);
  }
  return groups;
}

/** Busca por nome OU pela frase de documentação, sem diferenciar maiúsculas nem acento. Vazio devolve tudo. */
export function filterFunctions(docs: readonly FormulaFunctionDoc[], query: string): FormulaFunctionDoc[] {
  const needle = normalizeForSearch(query);
  if (needle.length === 0) return [...docs];
  return docs.filter((doc) => normalizeForSearch(doc.name).includes(needle) || normalizeForSearch(doc.doc).includes(needle));
}

/** Os diacríticos combinantes (U+0300–U+036F) que o NFD separa da letra — montado por código para não deixar caractere invisível no fonte. */
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");

function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .trim();
}

/**
 * Os `property_type` que o motor de fórmula consegue LER via `prop()` —
 * espelho de `map_property_type` em `src-tauri/src/ipc/formula_commands.rs`.
 * Uma propriedade fora deste conjunto (multi_select, person, files, outra
 * fórmula, …) reporta "propriedade não encontrada" no Rust, então a paleta
 * não a oferece: oferecer um botão que gera erro garantido é controle
 * morto.
 */
export const FORMULA_READABLE_TYPES: ReadonlySet<string> = new Set(["number", "text", "select", "status", "url", "checkbox", "date", "relation"]);

/** As propriedades irmãs que valem um botão `prop("Nome")` na paleta. A própria propriedade (mesmo id, quando já existe) fica de fora: seria auto-referência. */
export function referenceableProperties(properties: readonly PropertyDescriptor[], selfId: string): PropertyDescriptor[] {
  return properties.filter((property) => FORMULA_READABLE_TYPES.has(property.type) && (selfId === "" || property.id !== selfId));
}
