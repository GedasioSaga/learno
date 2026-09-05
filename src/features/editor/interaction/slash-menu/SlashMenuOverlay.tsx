/**
 * O popup do menu "/" (EDT-047) - `EditorOverlay` registrado em
 * `register.ts`. Não decide nada sobre navegação por teclado (isso é
 * `slash-menu-extension.ts`, que roda antes de qualquer render React); só lê
 * `slash-menu-store.ts` e desenha, mais o clique do mouse como segunda forma
 * de escolher um item.
 */
import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { exitSuggestion } from "@tiptap/suggestion";
import { clearSlashQuery } from "../../core/commands";
import { collectSlashMenuItems } from "../../core/block-spec";
import "./slash-menu.css";
import { slashMenuPluginKey } from "./slash-menu-extension";
import { filterSlashMenuItems, groupSlashMenuItems } from "./slash-menu-filter";
import { useSlashMenuStore } from "./slash-menu-store";

interface SlashMenuOverlayProps {
  editor: Editor;
}

export function SlashMenuOverlay({ editor }: SlashMenuOverlayProps) {
  const active = useSlashMenuStore((state) => state.active);
  const query = useSlashMenuStore((state) => state.query);
  const rect = useSlashMenuStore((state) => state.rect);
  const highlightedId = useSlashMenuStore((state) => state.highlightedId);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = groupSlashMenuItems(filterSlashMenuItems(collectSlashMenuItems(), query));
  const visible = groups.flatMap((group) => group.items);
  const activeId = highlightedId ?? visible[0]?.id ?? null;

  // Clique fora fecha: a suggestion do TipTap só cuida disso sozinha quando
  // renderizada pelo `mount()` dela (ver o .d.ts do pacote) - este overlay é
  // montado pelo registro do core, não por aquele mecanismo, então precisa
  // do próprio listener.
  useEffect(() => {
    if (!active) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (listRef.current?.contains(target)) return;
      exitSuggestion(editor.view, slashMenuPluginKey);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [active, editor]);

  if (!active || !rect) return null;

  function choose(itemId: string) {
    const item = visible.find((candidate) => candidate.id === itemId);
    if (!item) return;
    clearSlashQuery(editor, query.length);
    item.run(editor);
    exitSuggestion(editor.view, slashMenuPluginKey);
  }

  return (
    <div
      ref={listRef}
      className="ed-slash-menu"
      style={{ left: rect.left, top: rect.bottom }}
      role="listbox"
      aria-label="Inserir bloco"
      aria-activedescendant={activeId ? `ed-slash-menu-item-${activeId}` : undefined}
    >
      {visible.length === 0 ? (
        <p className="ed-slash-menu__empty">Nenhum bloco encontrado</p>
      ) : (
        groups.map((group) => (
          <div className="ed-slash-menu__group" key={group.name}>
            <p className="ed-slash-menu__group-title">{group.name}</p>
            {group.items.map((item) => (
              <button
                key={item.id}
                id={`ed-slash-menu-item-${item.id}`}
                type="button"
                role="option"
                aria-selected={item.id === activeId}
                className={
                  item.id === activeId ? "ed-slash-menu__item ed-slash-menu__item--active" : "ed-slash-menu__item"
                }
                // `onMouseDown`, não `onClick`: o clique tiraria o foco do
                // editor antes do handler rodar, perdendo a seleção onde o
                // bloco precisa entrar.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item.id);
                }}
              >
                {item.icon && (
                  <span className="ed-slash-menu__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
