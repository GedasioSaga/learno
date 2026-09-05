/**
 * Registro do tipo `person` (arquitetura §6) — o que DBS-082/083
 * (`prop("Responsável").email()` na fórmula) e a cláusula "Person" de
 * DBS-120 (regra de cor condicional) consultam. A UI completa de atribuição
 * multi-pessoa que o texto de DBS-015 descreve NÃO está aqui — ver o
 * cabeçalho de `person-value.ts` e `divergencias_da_arquitetura` no
 * relatório desta peça: o fixture compartilhado já congela `PersonValue`
 * como singular, e esta peça fecha só DBS-024/026.
 */
import { useState, type FormEvent } from "react";
import type { PersonValue } from "../../contract";
import type { CellEditContext, CellRenderContext, PropertySpec } from "../../core/property-spec";
import { EMPTY_PERSON_VALUE, formatPersonPlainText, isPersonValueEmpty, normalizePersonValue, parsePersonValue } from "./person-value";

export type PersonPropertyConfig = Record<string, never>;

export const DEFAULT_PERSON_CONFIG: PersonPropertyConfig = {};

function renderPersonCell({ value }: CellRenderContext<PersonValue, PersonPropertyConfig>) {
  if (isPersonValueEmpty(value)) return null;
  return <span className="truncate rounded-full bg-surface-sunken px-2 py-0.5 text-sm text-ink">{formatPersonPlainText(value)}</span>;
}

/**
 * Formulário mínimo: nome (obrigatório) + e-mail (opcional). "Remover"
 * manda `EMPTY_PERSON_VALUE`, que `normalizePersonValue` reconhece como
 * vazio — é assim que I1 apaga a linha através de um `commit()` que só
 * aceita `PersonValue`, nunca `null` (contrato de `CellEditContext`).
 */
function renderPersonEditor({ value, commit, close }: CellEditContext<PersonValue, PersonPropertyConfig>) {
  return <PersonEditorForm initial={value} commit={commit} close={close} />;
}

function PersonEditorForm({
  initial,
  commit,
  close,
}: {
  initial: PersonValue;
  commit: (next: PersonValue) => void;
  close: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email ?? "");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizePersonValue({ name, email });
    commit(normalized ?? EMPTY_PERSON_VALUE);
    close();
  }

  function handleRemove() {
    commit(EMPTY_PERSON_VALUE);
    close();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 p-2">
      <label className="flex flex-col gap-1 text-sm text-ink-muted">
        Nome
        <input
          aria-label="Nome da pessoa"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded-sm border border-surface-sunken px-2 py-1 text-ink"
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-ink-muted">
        Email (opcional)
        <input
          aria-label="Email da pessoa"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="rounded-sm border border-surface-sunken px-2 py-1 text-ink"
        />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" aria-label="Remover pessoa" onClick={handleRemove} className="rounded-sm px-2 py-1 text-sm text-terracotta-ink hover:bg-surface-sunken">
          Remover
        </button>
        <button type="submit" aria-label="Salvar pessoa" className="rounded-sm bg-ink px-2 py-1 text-sm text-surface hover:opacity-90">
          Salvar
        </button>
      </div>
    </form>
  );
}

export const personPropertySpec: PropertySpec<PersonValue, PersonPropertyConfig> = {
  type: "person",
  label: "Pessoa",
  icon: "👤",
  valueShape: "person",
  defaultConfig: DEFAULT_PERSON_CONFIG,
  isEmpty: isPersonValueEmpty,
  normalize: normalizePersonValue,
  parse: parsePersonValue,
  serialize: (value) => value,
  renderValue: renderPersonCell,
  renderEditor: renderPersonEditor,
  filterOperators: ["is", "isNot", "isEmpty", "isNotEmpty"],
  // 0017 não extrai um nome de dentro de um objeto Pessoa — a coluna gerada
  // `sort_text` só olha `value->>'start'`/`value->>'text'` para jsonb
  // objeto (`docs/FASE-3-SCHEMA.sql`, item 3); um `person` cai no `ELSE
  // NULL` dela, então não há chave utilizável para ordenar por.
  sort: "none",
  toPlainText: (value) => formatPersonPlainText(value),
};
