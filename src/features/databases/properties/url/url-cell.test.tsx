/**
 * DBS-018 atravessa duas fronteiras: o DOM (clique real, não uma chamada
 * direta) e a decisão de abrir vs. editar. `openBookmarkUrl`
 * (`editor/blocks/bookmark/open-url.ts`) já tem sua própria suíte provando
 * "abre pelo plugin opener dentro do Tauri, `window.open` fora"; aqui a
 * prova é que a CÉLULA aciona essa função no clique e NUNCA deixa o clique
 * chegar a um handler de "iniciar edição" por cima dela.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { urlPropertySpec } from "./url-spec";
import type { CellRenderContext } from "../../core/property-spec";
import type { UrlConfig, UrlValue } from "./url-spec";
import type { RecordRow } from "../../contract";

afterEach(cleanup);

const property = { id: "prop-1", databaseId: "db-1", name: "Site", type: "url", config: {}, position: "a0" };

const record: RecordRow = {
  id: "rec-1",
  title: "Registro de teste",
  icon: null,
  parentId: null,
  position: "a0",
  createdAt: "2026-01-01T00:00:00",
  updatedAt: "2026-01-01T00:00:00",
  values: {},
  matchedColorRuleIds: [],
};

function ctxFor(value: UrlValue): CellRenderContext<UrlValue, UrlConfig> {
  return { value, property, record, density: "grid", readOnly: false };
}

describe("DBS-018 — URL válida clicada abre, nunca entra em edição", () => {
  it("clique numa URL válida chama o abridor de link (fora do Tauri: window.open)", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<>{urlPropertySpec.renderValue(ctxFor("https://example.com/curso"))}</>);

    fireEvent.click(screen.getByRole("button", { name: "Abrir example.com no navegador" }));

    expect(openSpy).toHaveBeenCalledWith("https://example.com/curso", "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });

  it("o clique NUNCA chega a um handler de 'iniciar edição' por cima da célula", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const startEditing = vi.fn();

    // O `<div onClick>` aqui é só o stand-in do wrapper hipotético que a
    // grade (Tabela/Board, outra peça) poria em volta da célula — não é UI
    // real desta pasta.
    render(<div onClick={startEditing}>{urlPropertySpec.renderValue(ctxFor("https://example.com"))}</div>);
    fireEvent.click(screen.getByRole("button"));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(startEditing).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("esquema recusado (javascript:) fica inerte: botão desabilitado, nunca chama o abridor", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<>{urlPropertySpec.renderValue(ctxFor("javascript:alert(1)"))}</>);

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    fireEvent.click(button);

    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("célula vazia (null) não renderiza nada clicável", () => {
    const { container } = render(<>{urlPropertySpec.renderValue(ctxFor(null))}</>);
    expect(container).toBeEmptyDOMElement();
  });
});
