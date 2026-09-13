/**
 * O menu do cabeçalho de coluna — o do Notion, no que o Learno consegue
 * honrar hoje: renomear (inline, no próprio menu), mudar o tipo, editar a
 * configuração do tipo (a expressão de uma Fórmula), mover para a esquerda/
 * direita e apagar. Esconder, ordenar, filtrar e congelar por esta coluna
 * NÃO aparecem: dependem do pipeline de consulta (`open_view_query`) que
 * não existe — controle que não faz nada é defeito, não rascunho.
 *
 * Duas "páginas" no mesmo painel (raiz e "Tipo"), em vez de submenu
 * aninhado: um painel só cabe na coluna mais estreita, e Escape volta uma
 * página antes de fechar.
 *
 * Não é `role="menu"`: o primeiro controle é um `<input>` (o nome), e ARIA de
 * menu exigiria cada filho ser `menuitem*` — o mesmo raciocínio de
 * `pages/PageOptionsMenu.tsx`. Cada controle fica o que já é nativamente;
 * as setas ainda andam entre eles.
 *
 * Portal no `body`, posicionado por medida (`usePosicaoAncorada`): o `<th>`
 * recorta em `overflow: hidden`, e o contêiner de rolagem horizontal da
 * grade recorta na vertical também — um painel `absolute` sairia cortado.
 *
 * Movimento (DESIGN-TOKENS §9): abrir por clique entra em opacidade + escala
 * 0.95, `--motion-base`, ease-out, com origem no canto do cabeçalho; abrir
 * por teclado entra instantâneo (regra 3); fechar é instantâneo sempre.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { usePosicaoAncorada } from "../../../pages/use-posicao-ancorada";
import { useOpenTransition } from "../../../pages/use-open-transition";
import { isBackendPropertyType, STRUCTURAL_TYPES } from "../../core/backend-property-types";
import { collectPropertySpecs, type PropertyDescriptor, type PropertySpec } from "../../core/property-spec";
import type { PropertyActions } from "../../core/view-spec";
import { DeletePropertyDialog } from "./DeletePropertyDialog";

interface ColumnHeaderMenuProps {
  property: PropertyDescriptor;
  spec: PropertySpec | undefined;
  actions: PropertyActions;
  /** As colunas de propriedade na ordem MOSTRADA — para "mover" saber quem é a vizinha. */
  columns: readonly PropertyDescriptor[];
  /**
   * Falso quando a view tem `columnOrder` próprio: aí a ordem mostrada não
   * é a `position` da database, e `reorder_property` não mudaria nada na
   * tela — o item nem aparece.
   */
  moveEnabled: boolean;
  /** Quantos registros têm valor nesta coluna — o que se perde ao apagar. */
  filledCount: number;
}

type Page = "root" | "type";

export function ColumnHeaderMenu({ property, spec, actions, columns, moveEnabled, filledCount }: ColumnHeaderMenuProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>("root");
  // `true` quando o menu foi aberto pelo teclado: entra sem transição.
  const [instant, setInstant] = useState(false);
  const [name, setName] = useState(property.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // O último nome que já foi mandado ao backend — Enter e blur não podem
  // renomear duas vezes, nem renomear para o nome que já está lá.
  const committedNameRef = useRef(property.name);
  const entered = useOpenTransition(open);
  const ids = useId();
  const panelId = `${ids}-panel`;
  usePosicaoAncorada(triggerRef, panelRef, open);

  // O nome persistido mudou por fora (recarga depois de renomear): o
  // rascunho acompanha.
  useEffect(() => {
    setName(property.name);
    committedNameRef.current = property.name;
  }, [property.name]);

  useEffect(() => {
    if (!open) return;
    // Renomear é o pedido mais comum: o campo já vem focado, com o texto
    // selecionado, para "clicar e digitar" bastar.
    const input = nameInputRef.current;
    input?.focus();
    input?.select();

    function onPointerDown(event: PointerEvent) {
      // Um `pointerdown` real sempre mira um `Node` — ver `use-toggle-panel.ts`.
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Trocar de página desmonta o botão que tinha o foco, e o foco cairia no
  // `body` — Escape e setas parariam de responder até um clique. O foco vai
  // para o primeiro controle da página nova ("‹ Tipo" ao entrar na lista, o
  // nome ao voltar).
  useEffect(() => {
    if (!open) return;
    if (page === "type") panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    else nameInputRef.current?.focus();
  }, [open, page]);

  function openMenu(event: ReactMouseEvent<HTMLButtonElement>) {
    // `detail === 0` é ativação por teclado (Enter/Espaço): sem animação.
    setInstant(event.detail === 0);
    setPage("root");
    setOpen((value) => !value);
  }

  function close(returnFocus = true) {
    setOpen(false);
    setPage("root");
    if (returnFocus) triggerRef.current?.focus();
  }

  function commitRename() {
    const next = name.trim();
    if (next.length === 0 || next === committedNameRef.current) return;
    committedNameRef.current = next;
    // Em erro, o carregador recarrega (o nome antigo volta) e mostra a
    // mensagem abaixo da database — o mesmo caminho de uma célula que não
    // salvou.
    void actions.rename(property.id, next);
  }

  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
      close();
    }
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Nada daqui sobe para a grade (o portal preserva a árvore React).
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (page === "type") setPage("root");
      else close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
    }
  }

  /** Setas andam entre os controles focáveis do painel, dando a volta. */
  function moveFocus(delta: 1 | -1) {
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
    if (focusable.length === 0) return;
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const next = (current + delta + focusable.length) % focusable.length;
    focusable[next].focus();
  }

  function pickType(newType: string) {
    close(false);
    if (newType === property.type) return;
    void actions.changeType(property.id, newType);
  }

  const index = columns.findIndex((column) => column.id === property.id);
  const isFirst = index <= 0;
  const isLast = index === columns.length - 1;

  function moveLeft() {
    close(false);
    // Fica DEPOIS da coluna duas à esquerda; se não há, vai para primeiro.
    const after = index >= 2 ? columns[index - 2].id : null;
    void actions.reorder(property.id, after);
  }

  function moveRight() {
    close(false);
    void actions.reorder(property.id, columns[index + 1].id);
  }

  // Tipos oferecidos: registrados E aceitos pelo Rust, menos os
  // estruturais (o Rust recusa trocar de/para eles). Uma coluna estrutural
  // nem mostra "Tipo".
  const canChangeType = !STRUCTURAL_TYPES.has(property.type);
  const typeChoices = collectPropertySpecs().filter((candidate) => isBackendPropertyType(candidate.type) && !STRUCTURAL_TYPES.has(candidate.type));
  const configLabel = spec ? `Editar ${spec.label.toLowerCase()}…` : null;
  const readOnly = !spec?.renderEditor;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openMenu}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={readOnly ? `${property.name} — calculado automaticamente` : property.name}
        className="db-table__th-button"
      >
        <span className="db-table__th-icon" aria-hidden="true">
          {spec?.icon ?? "?"}
        </span>
        <span className="db-table__th-name">{property.name}</span>
        <span className="db-table__th-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>

      {open
        ? createPortal(
            <div
              id={panelId}
              ref={panelRef}
              role="dialog"
              aria-label={`Opções da coluna ${property.name}`}
              tabIndex={-1}
              className="db-colmenu"
              data-entered={entered || instant ? "" : undefined}
              data-instant={instant ? "" : undefined}
              onKeyDown={handlePanelKeyDown}
              onClick={(event) => event.stopPropagation()}
            >
              {page === "root" ? (
                <>
                  <div className="db-colmenu__name">
                    <span className="db-colmenu__name-icon" aria-hidden="true">
                      {spec?.icon ?? "?"}
                    </span>
                    <input
                      ref={nameInputRef}
                      type="text"
                      aria-label="Nome da propriedade"
                      value={name}
                      onChange={(event) => setName(event.currentTarget.value)}
                      onKeyDown={handleNameKeyDown}
                      onBlur={commitRename}
                      className="db-colmenu__name-input"
                    />
                  </div>
                  <div className="db-colmenu__sep" role="presentation" />
                  {canChangeType ? (
                    <button type="button" className="db-colmenu__item" onClick={() => setPage("type")}>
                      Tipo
                      <span className="db-colmenu__hint">
                        {spec?.label ?? property.type}
                        <span aria-hidden="true"> ›</span>
                      </span>
                    </button>
                  ) : null}
                  {spec?.renderConfigForm && configLabel ? (
                    <button
                      type="button"
                      className="db-colmenu__item"
                      onClick={() => {
                        close(false);
                        actions.editConfig(property);
                      }}
                    >
                      {configLabel}
                    </button>
                  ) : null}
                  {moveEnabled ? (
                    <>
                      <div className="db-colmenu__sep" role="presentation" />
                      <button type="button" className="db-colmenu__item" onClick={moveLeft} disabled={isFirst} title={isFirst ? "Já é a primeira coluna" : undefined}>
                        Mover para a esquerda
                      </button>
                      <button type="button" className="db-colmenu__item" onClick={moveRight} disabled={isLast} title={isLast ? "Já é a última coluna" : undefined}>
                        Mover para a direita
                      </button>
                    </>
                  ) : null}
                  <div className="db-colmenu__sep" role="presentation" />
                  <button
                    type="button"
                    className="db-colmenu__item db-colmenu__item--danger"
                    onClick={() => {
                      close(false);
                      setConfirmingDelete(true);
                    }}
                  >
                    Apagar propriedade
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="db-colmenu__item db-colmenu__back" onClick={() => setPage("root")}>
                    <span aria-hidden="true">‹ </span>
                    Tipo
                  </button>
                  <div className="db-colmenu__sep" role="presentation" />
                  {typeChoices.map((candidate) => {
                    const current = candidate.type === property.type;
                    return (
                      <button
                        key={candidate.type}
                        type="button"
                        className="db-colmenu__item"
                        aria-pressed={current}
                        onClick={() => pickType(candidate.type)}
                      >
                        <span className="db-colmenu__type-icon" aria-hidden="true">
                          {candidate.icon}
                        </span>
                        {candidate.label}
                        {current ? (
                          <span className="db-colmenu__hint" aria-hidden="true">
                            ✓
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </>
              )}
            </div>,
            document.body,
          )
        : null}

      {confirmingDelete ? (
        <DeletePropertyDialog
          property={property}
          filledCount={filledCount}
          onCancel={() => {
            setConfirmingDelete(false);
            triggerRef.current?.focus();
          }}
          onConfirm={async () => {
            const result = await actions.delete(property.id);
            // Em sucesso a coluna some (e este componente com ela) — fechar
            // aqui é só para o caso de a recarga demorar. Em erro o diálogo
            // fica aberto e mostra a mensagem.
            if (result.ok) setConfirmingDelete(false);
            return result;
          }}
        />
      ) : null}
    </>
  );
}
