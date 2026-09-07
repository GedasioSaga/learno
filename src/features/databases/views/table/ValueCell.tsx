/**
 * Uma célula de PROPRIEDADE da Tabela. A célula é dona da caixa, da largura
 * e do foco (arquitetura §6); o CONTEÚDO vem inteiro do `PropertySpec` do
 * tipo — `renderValue` em repouso, `renderEditor` quando aberta. Esta
 * célula nunca sabe o que é um `select` ou uma `date`.
 *
 * O caminho de escrita, e onde I1 mora aqui: `commit(next)` passa por
 * `spec.normalize()` (que devolve `null` para "vazio" — `""` de texto,
 * `false` de checkbox, `[]` de multi-select) e manda `null` para o Rust,
 * que APAGA a linha. Nunca `!value`: `0` e `false` são decididos pelo spec.
 *
 * Checkbox é o único tipo cujo clique não "abre" nada (DBS-017: um clique
 * já alterna e persiste). `renderEditor` dele carrega `autoFocus`, então
 * não pode ficar montado em toda linha — a célula alterna o valor no
 * próprio clique/Espaço e manda pelo mesmo `commit`.
 */
import { Component, useEffect, useRef, type ErrorInfo, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { RecordRow } from "../../contract";
import type { PropertyDescriptor, PropertySpec } from "../../core/property-spec";
import type { ViewMutations } from "../../core/view-spec";
import { EditorFlyout } from "./EditorFlyout";

export interface ValueCellProps {
  record: RecordRow;
  property: PropertyDescriptor;
  /** `undefined` quando o `property_type` não tem spec registrado (build mais novo gravou um tipo que este não conhece). */
  spec: PropertySpec | undefined;
  mutations: ViewMutations | null;
  editing: boolean;
  focused: boolean;
  /** Muda quando a grade pede que a célula ativa receba o foco de verdade; `0` na montagem = nunca roubar o foco. */
  focusTick: number;
  onStartEdit(): void;
  onStopEdit(): void;
  onFocusCell(): void;
  onNavigate(event: KeyboardEvent<HTMLTableCellElement>): void;
}

/** `spec.parse` é TOTAL (nunca lança) e trata `undefined` — propriedade ausente do mapa — como vazio (I1). */
function rawValueOf(record: RecordRow, propertyId: string): unknown {
  return Object.prototype.hasOwnProperty.call(record.values, propertyId) ? record.values[propertyId] : undefined;
}

export function ValueCell({
  record,
  property,
  spec,
  mutations,
  editing,
  focused,
  focusTick,
  onStartEdit,
  onStopEdit,
  onFocusCell,
  onNavigate,
}: ValueCellProps) {
  const cellRef = useRef<HTMLTableCellElement>(null);
  // O último valor JÁ ENVIADO ao Rust nesta sessão de edição, serializado.
  // Evita mandar o mesmo valor duas vezes — o editor de texto commita no
  // blur E na desmontagem, e os dois disparam no mesmo fechamento.
  const lastSentRef = useRef<string | null>(null);

  const raw = rawValueOf(record, property.id);
  const readOnly = !spec?.renderEditor || mutations === null;
  const isBoolean = spec?.valueShape === "boolean";

  useEffect(() => {
    if (focused && !editing && focusTick > 0) cellRef.current?.focus();
  }, [focused, editing, focusTick]);

  function commit(next: unknown): void {
    if (!spec || !mutations) return;
    const normalized = spec.normalize(next, property.config);
    const value = normalized === null ? null : spec.serialize(normalized);
    const key = JSON.stringify(value ?? null);
    if (key === lastSentRef.current) return;
    lastSentRef.current = key;
    void mutations.applyValueChanges([{ recordId: record.id, propertyId: property.id, value }]);
  }

  function open(): void {
    if (readOnly) return;
    lastSentRef.current = JSON.stringify(raw ?? null);
    onStartEdit();
  }

  function toggleBoolean(): void {
    if (!spec || readOnly) return;
    lastSentRef.current = JSON.stringify(raw ?? null);
    commit(spec.parse(raw) !== true);
  }

  function handleClick(event: MouseEvent<HTMLTableCellElement>): void {
    if (editing) return;
    onFocusCell();
    // Um `<button>` dentro do valor (URL abre no navegador) já tratou o
    // clique e parou a propagação — nunca chega aqui. O que chega é clique
    // na "caixa": abrir.
    if (event.defaultPrevented) return;
    if (isBoolean) toggleBoolean();
    else open();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTableCellElement>): void {
    if (editing) return;
    if (event.key === "Enter" || event.key === "F2" || (event.key === " " && isBoolean)) {
      event.preventDefault();
      if (isBoolean) toggleBoolean();
      else open();
      return;
    }
    onNavigate(event);
  }

  const content: ReactNode = spec ? (
    <span className="db-table__value">
      <SpecRender key={JSON.stringify(raw ?? null)} render={() => spec.renderValue({ value: spec.parse(raw), property, record, density: "grid", readOnly })} />
    </span>
  ) : (
    <span className="db-table__value db-table__value--placeholder">tipo "{property.type}" desconhecido</span>
  );

  const className = ["db-table__cell", readOnly ? "db-table__cell--readonly" : ""].filter(Boolean).join(" ");

  return (
    <td
      ref={cellRef}
      role="gridcell"
      className={className}
      tabIndex={focused ? 0 : -1}
      aria-readonly={readOnly || undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onFocus={onFocusCell}
    >
      {content}
      {editing && spec?.renderEditor && mutations ? (
        <EditorFlyout anchorRef={cellRef} onClose={onStopEdit} label={`Editar ${property.name}`}>
          <SpecRender
            render={() =>
              spec.renderEditor?.({
                value: spec.parse(raw),
                property,
                record,
                commit,
                close: onStopEdit,
                targetCount: 1,
              })
            }
          />
        </EditorFlyout>
      ) : null}
    </td>
  );
}

/**
 * `parse`/`normalize` são TOTAIS por contrato; `renderValue`/`renderEditor`
 * NÃO têm essa garantia. Um valor corrompido que faça um renderizador
 * lançar não pode derrubar a grade (nem a página, se não houver boundary
 * acima): vira um placeholder de erro dentro da própria célula. A chave de
 * remontagem é do chamador — quando o valor muda, a célula tenta de novo.
 */
class CellErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Sem `console.log` de debug (regra 10), mas um erro de renderização
    // engolido em silêncio seria pior: fica no console de erro, com a pilha
    // do componente, para quem for investigar o dado corrompido.
    console.error("célula de database falhou ao renderizar", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <span className="db-table__value--placeholder" title="O valor gravado não pôde ser desenhado por este tipo de propriedade.">valor ilegível</span>;
    }
    return this.props.children;
  }
}

/**
 * Isola a chamada a `renderValue`/`renderEditor` num componente próprio.
 * Alguns specs chamam o componente de célula como FUNÇÃO
 * (`renderEditor: (ctx) => NumberCellEditor(ctx)`), e ele usa hooks — que
 * então rodam no render de quem chamou. Abrir/fechar o editor mudaria a
 * quantidade de hooks de `ValueCell` entre renders ("Rendered more hooks
 * than during the previous render"). Montar/desmontar ESTE componente
 * mantém a lista de hooks de cada um estável.
 */
function SpecRender({ render }: { render(): ReactNode }) {
  // `render()` precisa ser chamado DENTRO de um filho da boundary — como
  // expressão de children ele rodaria aqui, acima dela, e um `throw`
  // passaria direto.
  return (
    <CellErrorBoundary>
      <SpecRenderInner render={render} />
    </CellErrorBoundary>
  );
}

function SpecRenderInner({ render }: { render(): ReactNode }) {
  return <>{render()}</>;
}
