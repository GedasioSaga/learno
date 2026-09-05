/**
 * DBS-004 — renderização somente-leitura: negrito vira `<strong>` de
 * verdade (não `dangerouslySetInnerHTML`), e um link com esquema perigoso
 * nunca vira `<a>` navegável.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CellRenderContext } from "../../core/property-spec";
import { renderRichTextValue } from "./RichTextCell";
import type { RichTextConfig, RichTextValue } from "./rich-text-value";

function ctxFor(value: RichTextValue): CellRenderContext<RichTextValue, RichTextConfig> {
  return {
    value,
    property: { id: "p1", databaseId: "d1", name: "Notas", type: "text", config: {}, position: "a0" },
    record: {
      id: "r1",
      title: "Registro",
      icon: null,
      parentId: null,
      position: "a0",
      createdAt: "2026-01-01T00:00:00",
      updatedAt: "2026-01-01T00:00:00",
      values: {},
      matchedColorRuleIds: [],
    },
    density: "grid",
    readOnly: false,
  };
}

describe("renderRichTextValue", () => {
  it("valor vazio não renderiza nada", () => {
    const { container } = render(<>{renderRichTextValue(ctxFor([]))}</>);
    expect(container).toBeEmptyDOMElement();
  });

  it("negrito aparece como <strong> de verdade, não como HTML injetado", () => {
    const value: RichTextValue = [
      { type: "text", text: "isto é " },
      { type: "text", text: "negrito", marks: [{ type: "bold" }] },
    ];
    const { container } = render(<>{renderRichTextValue(ctxFor(value))}</>);
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("negrito");
    expect(container.textContent).toBe("isto é negrito");
  });

  it("marcas combinadas (negrito + itálico) aninham as duas tags", () => {
    const value: RichTextValue = [{ type: "text", text: "x", marks: [{ type: "bold" }, { type: "italic" }] }];
    const { container } = render(<>{renderRichTextValue(ctxFor(value))}</>);
    expect(container.querySelector("strong em, em strong")).not.toBeNull();
  });

  it("link com esquema http vira <a> clicável", () => {
    const value: RichTextValue = [
      { type: "text", text: "site", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
    ];
    const { container } = render(<>{renderRichTextValue(ctxFor(value))}</>);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
    expect(anchor?.getAttribute("rel")).toContain("noopener");
  });

  it("link com esquema `javascript:` NUNCA vira <a> — o texto continua visível, mas sem navegação possível", () => {
    const value: RichTextValue = [
      { type: "text", text: "clique aqui", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
    ];
    const { container } = render(<>{renderRichTextValue(ctxFor(value))}</>);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("clique aqui");
  });

  it("hardBreak vira <br>", () => {
    const value: RichTextValue = [{ type: "text", text: "linha 1" }, { type: "hardBreak" }, { type: "text", text: "linha 2" }];
    const { container } = render(<>{renderRichTextValue(ctxFor(value))}</>);
    expect(container.querySelector("br")).not.toBeNull();
  });
});
