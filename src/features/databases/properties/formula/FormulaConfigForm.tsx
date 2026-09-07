/**
 * O editor de fórmula — o `renderConfigForm` de `formulaPropertySpec`. A
 * régua é o editor do Notion: caixa de expressão monoespaçada, paleta de
 * funções agrupada por categoria (clicar insere), validação ao vivo com o
 * erro na posição exata, e prévia contra um registro real. O botão de
 * salvar só habilita com a expressão válida — expressão inválida não é
 * salvável.
 *
 * Tudo que aparece aqui vem do Rust: a lista de funções
 * (`list_formula_functions`, com `doc` e `arity` já em português), o
 * veredito e as mensagens (`validate_formula`, posições em UTF-16) e a
 * prévia (`preview_formula`). Este arquivo não conhece a gramática — não
 * há autocompletar dentro da caixa nem coloração de sintaxe, de propósito
 * (ver a bar desta peça): seria uma segunda gramática para manter em
 * sincronia com o Rust.
 *
 * `commit(config)` é chamado só com a expressão válida; quem persiste é
 * quem montou o formulário (`container/NewPropertyDialog.tsx`).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AppError,
  listFormulaFunctions,
  previewFormula,
  validateFormula,
  type DiagnosticDto,
  type FormulaFunctionDoc,
} from "../../../../lib/ipc";
import type { PropertyConfigFormContext } from "../../core/property-spec";
import { FormulaCellValue } from "./FormulaCell";
import {
  filterFunctions,
  groupFunctionsByCategory,
  insertFunctionCall,
  insertPropertyReference,
  lineAndColumn,
  referenceableProperties,
} from "./formula-editor";
import type { FormulaConfig } from "./formula-value";
import "./formula.css";

/** Tempo entre a última tecla e a validação — curto o bastante para parecer "ao vivo", longo o bastante para não validar a cada caractere. */
const VALIDATE_DEBOUNCE_MS = 150;

type Validation =
  | { kind: "idle" }
  | { kind: "validating" }
  | { kind: "valid"; returnType: string | null }
  | { kind: "invalid"; diagnostics: DiagnosticDto[] }
  | { kind: "failed"; message: string };

type Preview = { kind: "none" } | { kind: "loading" } | { kind: "ready"; value: unknown } | { kind: "failed"; message: string };

type Palette = { kind: "loading" } | { kind: "ready"; functions: FormulaFunctionDoc[] } | { kind: "failed"; message: string };

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

interface FormulaConfigFormProps {
  ctx: PropertyConfigFormContext<FormulaConfig>;
}

export function FormulaConfigForm({ ctx }: FormulaConfigFormProps) {
  const { property, properties, records, commit } = ctx;
  const isNew = property.id === "";
  const [expression, setExpression] = useState(ctx.config.expression);
  const [validation, setValidation] = useState<Validation>({ kind: "idle" });
  const [preview, setPreview] = useState<Preview>({ kind: "none" });
  const [previewRecordId, setPreviewRecordId] = useState<string | null>(records[0]?.id ?? null);
  const [palette, setPalette] = useState<Palette>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Uma resposta antiga de validação/prévia não pode pousar por cima da
  // nova — mesma guarda de `requestRef` em `loader/use-database.ts`.
  const requestRef = useRef(0);
  const ids = useId();
  const textareaId = `${ids}-expression`;
  const statusId = `${ids}-status`;
  const previewRecordSelectId = `${ids}-preview-record`;
  const searchId = `${ids}-search`;

  useEffect(() => {
    let cancelled = false;
    listFormulaFunctions()
      .then((functions) => {
        if (!cancelled) setPalette({ kind: "ready", functions });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPalette({ kind: "failed", message: messageFor(error, "Não foi possível carregar a lista de funções.") });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Validação ao vivo, e a prévia logo atrás quando a expressão é válida e
  // há um registro escolhido. Uma chamada por pausa na digitação.
  useEffect(() => {
    const trimmed = expression.trim();
    if (trimmed.length === 0) {
      setValidation({ kind: "idle" });
      setPreview({ kind: "none" });
      return;
    }
    const request = ++requestRef.current;
    setValidation({ kind: "validating" });
    const timer = window.setTimeout(() => {
      validateFormula(property.databaseId, isNew ? null : property.id, expression)
        .then(async (result) => {
          if (request !== requestRef.current) return;
          if (!result.valid) {
            setValidation({ kind: "invalid", diagnostics: result.diagnostics });
            setPreview({ kind: "none" });
            return;
          }
          setValidation({ kind: "valid", returnType: result.returnType });
          if (previewRecordId === null) {
            setPreview({ kind: "none" });
            return;
          }
          setPreview({ kind: "loading" });
          try {
            const previewed = await previewFormula(property.databaseId, previewRecordId, expression);
            if (request !== requestRef.current) return;
            setPreview({ kind: "ready", value: previewed.value });
          } catch (error) {
            if (request !== requestRef.current) return;
            setPreview({ kind: "failed", message: messageFor(error, "Não foi possível calcular a prévia.") });
          }
        })
        .catch((error: unknown) => {
          if (request !== requestRef.current) return;
          setValidation({ kind: "failed", message: messageFor(error, "Não foi possível validar a fórmula.") });
          setPreview({ kind: "none" });
        });
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [expression, property.databaseId, property.id, isNew, previewRecordId]);

  function applyInsertion(next: string, caret: number) {
    setExpression(next);
    // O foco volta para a caixa com o cursor onde a inserção deixou —
    // depois do render, para o textarea já ter o texto novo.
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  }

  function selectionOf(): [number, number] {
    const textarea = textareaRef.current;
    if (!textarea) return [expression.length, expression.length];
    return [textarea.selectionStart, textarea.selectionEnd];
  }

  function insertFunction(name: string) {
    const [start, end] = selectionOf();
    const insertion = insertFunctionCall(expression, start, end, name);
    applyInsertion(insertion.next, insertion.caret);
  }

  function insertProperty(name: string) {
    const [start, end] = selectionOf();
    const insertion = insertPropertyReference(expression, start, end, name);
    applyInsertion(insertion.next, insertion.caret);
  }

  function jumpTo(diagnostic: DiagnosticDto) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(diagnostic.start, Math.max(diagnostic.start, diagnostic.end));
  }

  const canSave = validation.kind === "valid" && expression.trim().length > 0;
  const invalid = validation.kind === "invalid";
  const referenceable = referenceableProperties(properties, property.id);
  const previewRecord = records.find((record) => record.id === previewRecordId) ?? null;

  return (
    <div className="formula-editor">
      <div className="formula-editor__main">
        <label htmlFor={textareaId} className="text-sm font-medium text-ink">
          Expressão
        </label>
        <div className={["formula-editor__box", invalid ? "formula-editor__box--invalid" : ""].filter(Boolean).join(" ")}>
          <pre className="formula-editor__mirror" aria-hidden="true">
            {mirrorContent(expression, validation.kind === "invalid" ? validation.diagnostics : [])}
          </pre>
          <textarea
            ref={textareaRef}
            id={textareaId}
            className="formula-editor__textarea"
            value={expression}
            onChange={(event) => setExpression(event.currentTarget.value)}
            placeholder={'prop("Nota") * 2'}
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={invalid || undefined}
            aria-describedby={statusId}
          />
        </div>

        <div id={statusId} className={statusClassName(validation)} role={invalid || validation.kind === "failed" ? "alert" : "status"}>
          {renderStatus(validation, expression, jumpTo)}
        </div>

        <section className="formula-editor__preview" aria-label="Prévia">
          <div className="formula-editor__preview-head">
            <span>Prévia com dado real</span>
            {records.length > 0 ? (
              <label className="flex items-center gap-2">
                <span className="sr-only" id={`${previewRecordSelectId}-label`}>
                  Registro da prévia
                </span>
                <select
                  id={previewRecordSelectId}
                  aria-labelledby={`${previewRecordSelectId}-label`}
                  className="formula-editor__preview-record"
                  value={previewRecordId ?? ""}
                  onChange={(event) => setPreviewRecordId(event.currentTarget.value)}
                >
                  {records.map((record) => (
                    <option key={record.id} value={record.id}>
                      {record.title.trim().length > 0 ? record.title : "Sem título"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className={["formula-editor__preview-value", preview.kind !== "ready" ? "formula-editor__preview-value--empty" : ""].filter(Boolean).join(" ")}>
            {renderPreview(preview, records.length, previewRecord?.title ?? null, property)}
          </div>
        </section>

        <div className="formula-editor__actions">
          <button
            type="button"
            onClick={() => commit({ expression: expression.trim() })}
            disabled={!canSave}
            className="rounded-sm bg-emerald px-4 py-2 text-sm font-medium text-on-emerald transition hover:brightness-110 active:scale-97 disabled:opacity-50 disabled:pointer-events-none"
          >
            {isNew ? "Criar propriedade" : "Salvar fórmula"}
          </button>
          {!canSave && validation.kind === "idle" ? (
            <span className="text-sm text-ink-muted">Escreva uma expressão para habilitar.</span>
          ) : null}
        </div>
      </div>

      <aside className="formula-palette" aria-label="Funções e propriedades">
        <label htmlFor={searchId} className="sr-only">
          Buscar função
        </label>
        <input
          id={searchId}
          type="search"
          className="formula-palette__search"
          placeholder="Buscar função"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="formula-palette__scroll">
          {referenceable.length > 0 ? (
            <section aria-labelledby={`${ids}-props`}>
              <h3 id={`${ids}-props`} className="formula-palette__group-title">
                Propriedades desta database
              </h3>
              <ul className="formula-palette__list">
                {referenceable.map((sibling) => (
                  <li key={sibling.id}>
                    <button type="button" className="formula-palette__item" onClick={() => insertProperty(sibling.name)}>
                      <span className="formula-palette__item-head">
                        <span className="formula-palette__name">prop("{sibling.name}")</span>
                        <span className="formula-palette__arity">{sibling.type}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {renderPalette(palette, query, ids, insertFunction)}
        </div>
      </aside>
    </div>
  );
}

function statusClassName(validation: Validation): string {
  const modifier =
    validation.kind === "valid" ? "formula-editor__status--valid" : validation.kind === "invalid" || validation.kind === "failed" ? "formula-editor__status--invalid" : "";
  return ["formula-editor__status", modifier].filter(Boolean).join(" ");
}

function renderStatus(validation: Validation, expression: string, jumpTo: (diagnostic: DiagnosticDto) => void): ReactNode {
  switch (validation.kind) {
    case "idle":
      return "Escreva uma expressão ou escolha uma função ao lado.";
    case "validating":
      return "Verificando…";
    case "valid":
      return validation.returnType ? `Válida. Resultado: ${validation.returnType}.` : "Válida.";
    case "failed":
      return validation.message;
    case "invalid":
      return (
        <ul className="formula-editor__diagnostics">
          {validation.diagnostics.map((diagnostic, index) => {
            const position = lineAndColumn(expression, diagnostic.start);
            return (
              <li key={`${diagnostic.start}-${index}`} className="formula-editor__diagnostic">
                <button type="button" className="formula-editor__jump" onClick={() => jumpTo(diagnostic)}>
                  linha {position.line}, coluna {position.column}
                </button>
                <span>{diagnostic.message}</span>
              </li>
            );
          })}
        </ul>
      );
  }
}

function renderPreview(
  preview: Preview,
  recordCount: number,
  recordTitle: string | null,
  property: PropertyConfigFormContext<FormulaConfig>["property"],
): ReactNode {
  if (recordCount === 0) return "Esta database ainda não tem registros; a prévia aparece quando houver uma linha.";
  switch (preview.kind) {
    case "none":
      return "O resultado para o registro escolhido aparece aqui quando a expressão for válida.";
    case "loading":
      return "Calculando…";
    case "failed":
      return preview.message;
    case "ready":
      if (preview.value === null || preview.value === undefined) {
        return `Vazio para ${recordTitle && recordTitle.trim().length > 0 ? `“${recordTitle}”` : "este registro"}.`;
      }
      return <FormulaCellValue value={preview.value} property={property} />;
  }
}

/** Espaço de largura zero (U+200B), montado por código para não deixar caractere invisível no fonte. */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * O texto do espelho: o mesmo da caixa, com cada trecho de erro envolto em
 * `<mark>` (sublinhado ondulado, texto transparente). Uma quebra de linha
 * final ganha um espaço de largura zero para o espelho ter a mesma altura
 * do textarea.
 */
function mirrorContent(expression: string, diagnostics: readonly DiagnosticDto[]): ReactNode {
  const ranges = diagnostics
    .map((diagnostic) => ({ start: Math.max(0, diagnostic.start), end: Math.min(expression.length, Math.max(diagnostic.start + 1, diagnostic.end)) }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push(expression.slice(cursor, range.start));
    parts.push(<mark key={range.start}>{expression.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < expression.length) parts.push(expression.slice(cursor));
  if (expression.endsWith("\n") || expression.length === 0) parts.push(ZERO_WIDTH_SPACE);
  return parts;
}

function renderPalette(palette: Palette, query: string, ids: string, insertFunction: (name: string) => void): ReactNode {
  if (palette.kind === "loading") return <p className="formula-palette__status">Carregando funções…</p>;
  if (palette.kind === "failed") {
    return (
      <p className="formula-palette__status formula-palette__status--error" role="alert">
        {palette.message}
      </p>
    );
  }
  const groups = groupFunctionsByCategory(filterFunctions(palette.functions, query));
  if (groups.length === 0) return <p className="formula-palette__empty">Nenhuma função com “{query}”.</p>;
  return groups.map((group) => {
    const headingId = `${ids}-${group.category}`;
    return (
      <section key={group.category} aria-labelledby={headingId}>
        <h3 id={headingId} className="formula-palette__group-title">
          {group.category}
        </h3>
        <ul className="formula-palette__list">
          {group.functions.map((doc) => (
            <li key={doc.name}>
              <button type="button" className="formula-palette__item" onClick={() => insertFunction(doc.name)}>
                <span className="formula-palette__item-head">
                  <span className="formula-palette__name">{doc.name}</span>
                  <span className="formula-palette__arity">{doc.arity}</span>
                </span>
                <span className="formula-palette__doc">{doc.doc}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  });
}
