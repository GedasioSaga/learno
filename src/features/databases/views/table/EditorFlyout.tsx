/**
 * A caixa flutuante que envolve um editor de célula aberto — o mecanismo
 * único de "célula expandida" da Tabela. Vai para o `body` por portal,
 * posicionada pelo retângulo da célula: dentro do contêiner de rolagem
 * horizontal (`overflow-x: auto` também recorta na vertical) um editor de
 * seleção na última linha seria cortado ao meio.
 *
 * Fecha por Escape (quando o editor de dentro não a consumiu antes) e por
 * clique fora (pointerdown fora do flyout, mesmo padrão de
 * `view-config/use-toggle-panel.ts`). Se o editor não puxou o foco para
 * dentro (o de multi-select não tem `autoFocus`), o flyout se foca sozinho
 * para Escape funcionar e o leitor de tela saber onde está.
 *
 * Sem animação de entrada: abrir célula é ação de altíssima frequência e
 * quase sempre iniciada por teclado (regras 2 e 3 de movimento).
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface EditorFlyoutProps {
  label: string;
  /** A célula que o flyout cobre. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
  children: ReactNode;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

function measure(anchor: HTMLElement | null): Box | null {
  if (!anchor) return null;
  const rect = anchor.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

export function EditorFlyout({ label, anchorRef, onClose, children }: EditorFlyoutProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(() => measure(anchorRef.current));

  // Segue a célula quando a página rola ou a janela muda de tamanho —
  // `position: fixed` não acompanha sozinho.
  useLayoutEffect(() => {
    const update = () => setBox(measure(anchorRef.current));
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchorRef]);

  useEffect(() => {
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) node.focus();
  }, []);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      // Um `pointerdown` real sempre mira um `Node` — ver o comentário
      // idêntico em `use-toggle-panel.ts`.
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
    }
    // Setas/Enter dentro do editor são do editor — nunca sobem para a
    // navegação de célula da grade (o portal preserva a árvore React, então
    // sem isto o `<td>` ainda receberia o evento).
    event.stopPropagation();
  }

  const style = box
    ? { top: box.top, left: box.left, minWidth: box.width, minHeight: box.height }
    : { top: 0, left: 0 };

  return createPortal(
    <div
      ref={ref}
      role="group"
      aria-label={label}
      tabIndex={-1}
      className="db-table__editor"
      style={style}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
