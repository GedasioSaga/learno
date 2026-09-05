/**
 * DBS-004 — renderização somente-leitura de uma célula de Texto (grid,
 * card, row ou peek — a densidade só muda `data-density` via CSS, nunca o
 * conteúdo). Constrói a árvore de marcas com elementos React de verdade
 * (`<strong>`, `<em>`, ...) — nunca `dangerouslySetInnerHTML` a partir do
 * texto do usuário, que é exatamente a regra de segurança que probíbe XSS
 * aqui: o texto de cada nó passa pelo escape automático do React, e só o
 * `href` de uma marca `link` é um valor que poderia carregar um esquema
 * perigoso (`javascript:`) — por isso `safeHref` abaixo é a única porta de
 * saída para fora de um `<span>`/`<strong>`/etc.
 */
import type { ReactNode } from "react";
import type { CellRenderContext } from "../../core/property-spec";
import type { InlineMark, RichTextConfig, RichTextNode, RichTextValue } from "./rich-text-value";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** `null` para qualquer coisa que não seja um link com esquema seguro — inclusive `javascript:`, `data:` e URLs malformadas. Nunca lança. */
function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

function wrapWithMark(content: ReactNode, mark: InlineMark): ReactNode {
  switch (mark.type) {
    case "code":
      return <code>{content}</code>;
    case "strike":
      return <s>{content}</s>;
    case "underline":
      return <u>{content}</u>;
    case "italic":
      return <em>{content}</em>;
    case "bold":
      return <strong>{content}</strong>;
    case "link": {
      const href = mark.attrs?.href ? safeHref(mark.attrs.href) : null;
      // Sem `href` seguro, a marca é descartada na renderização (o texto
      // continua visível) — nunca vira um `<a>` que poderia navegar para
      // um esquema perigoso.
      return href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      ) : (
        content
      );
    }
  }
}

function renderNode(node: RichTextNode, key: number): ReactNode {
  if (node.type === "hardBreak") return <br key={key} />;
  const content = (node.marks ?? []).reduce<ReactNode>((acc, mark) => wrapWithMark(acc, mark), node.text);
  return <span key={key}>{content}</span>;
}

export function renderRichTextValue({
  value,
  density,
}: CellRenderContext<RichTextValue, RichTextConfig>): ReactNode {
  if (!value || value.length === 0) return null;
  return (
    <span className="db-rich-text" data-density={density}>
      {value.map((node, index) => renderNode(node, index))}
    </span>
  );
}
