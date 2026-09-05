/**
 * DBS-004 — smoke do lado interativo: o componente monta de verdade (schema
 * `Document.extend({ content: "inline*" })` + as seis marcas realmente
 * constrói um `Editor` do TipTap sem lançar), e desfocar/Esc chamam
 * `ctx.commit()`/`ctx.close()` de verdade.
 *
 * NÃO simula digitação via `user.keyboard()` dentro do `contenteditable`: o
 * jsdom não implementa `Element.getClientRects()`/`document.elementFromPoint`
 * que o `EditorView` do ProseMirror usa para resolver clique/seleção real
 * (mesma lacuna que `docs/ACHADOS-FASE-2.md` documenta para o harness de
 * e2e) — a tentativa inicial deste arquivo media isso e a digitação caía no
 * vazio (`commit` chamado com `[]`), não porque a fiação estivesse errada.
 * A fidelidade de negrito num trecho DIGITADO de verdade (o critério de
 * DBS-004) está provada com instâncias headless de `Editor` — sem DOM,
 * sem essa lacuna do jsdom — em `register.test.ts`. Este arquivo prova só a
 * fiação React ao redor: montagem, `role`/`aria-label`, e blur/Esc
 * disparando `commit`/`close` com o conteúdo que o editor JÁ tinha.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CellEditContext } from "../../core/property-spec";
import { RichTextEditor } from "./RichTextEditor";
import type { RichTextConfig, RichTextValue } from "./rich-text-value";

/**
 * jsdom não implementa geometria de layout (`Range.getClientRects`) — o
 * ProseMirror consulta isso para rolar a seleção para a vista sempre que o
 * foco muda, e sem o polyfill isso lança dentro de um listener assíncrono
 * de `selectionchange`, que o Vitest reporta como erro não tratado mesmo
 * com a asserção do teste passando. Local a este arquivo — não mexe em
 * `src/test/setup.ts`, que é compartilhado por todas as outras peças.
 */
beforeAll(() => {
  // `as`: um polyfill de teste só precisa satisfazer a FORMA que o
  // ProseMirror lê (`length`/iteração); não é um `DOMRectList` real porque
  // jsdom não tem geometria nenhuma para gerar um de verdade.
  const emptyRectList = { item: () => null, length: 0, [Symbol.iterator]: () => [][Symbol.iterator]() } as DOMRectList;
  Range.prototype.getClientRects = () => emptyRectList;
  Range.prototype.getBoundingClientRect = () =>
    // `as`: mesma razão — um retângulo zerado, não uma medida real de layout.
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => "" }) as DOMRect;
});

function ctxFor(value: RichTextValue) {
  const commit = vi.fn<(next: RichTextValue) => void>();
  const close = vi.fn<() => void>();
  const ctx: CellEditContext<RichTextValue, RichTextConfig> = {
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
    commit,
    close,
    targetCount: 1,
  };
  return { ctx, commit, close };
}

describe("RichTextEditor", () => {
  it("monta com o conteúdo inicial e expõe `role=textbox`/`aria-label` (regra de acessibilidade)", () => {
    const { ctx } = ctxFor([{ type: "text", text: "olá" }]);
    render(<RichTextEditor ctx={ctx} />);
    const box = screen.getByRole("textbox", { name: "Notas" });
    expect(box).toHaveTextContent("olá");
  });

  it("desfocar grava o conteúdo atual via `commit` e fecha a célula", async () => {
    const { ctx, commit, close } = ctxFor([{ type: "text", text: "conteúdo existente" }]);
    const user = userEvent.setup();
    render(
      <>
        <RichTextEditor ctx={ctx} />
        <button type="button">fora</button>
      </>,
    );

    screen.getByRole("textbox").focus();
    await user.click(screen.getByRole("button", { name: "fora" }));

    expect(commit).toHaveBeenCalledWith([{ type: "text", text: "conteúdo existente" }]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("Esc grava e fecha sem esperar o blur", async () => {
    const { ctx, close } = ctxFor([{ type: "text", text: "x" }]);
    const user = userEvent.setup();
    render(<RichTextEditor ctx={ctx} />);

    screen.getByRole("textbox").focus();
    await user.keyboard("{Escape}");

    expect(close).toHaveBeenCalledOnce();
  });
});
