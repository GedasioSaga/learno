/**
 * DBS-004 — a prova central: "negrito aplicado a um trecho reaparece
 * idêntico ao reabrir em nova sessão". Duas instâncias REAIS de `Editor`
 * (`@tiptap/core`, headless, mesmo padrão de
 * `src/features/editor/blocks/code/code-block.test.ts`) com os mesmos
 * `RICH_TEXT_CELL_EXTENSIONS` desta propriedade — uma "escreve", a outra
 * "reabre" — com o valor `serialize()`d passando por um round trip de
 * `JSON.stringify`/`JSON.parse` no meio, que é exatamente o que o jsonb do
 * Postgres faz com um valor escalar string (não perde nem reordena um
 * caractere). O conteúdo nasce de comandos reais do editor (digitar,
 * selecionar, `toggleBold`) — não um JSON fabricado à mão, a forma exata do
 * problema que `docs/ACHADOS-FASE-2.md` documenta para FUN-044.
 *
 * ## Divergência da arquitetura
 *
 * Isto prova o round trip TipTap -> jsonb-string -> TipTap, mas não bate
 * literalmente no Postgres: minha pasta exclusiva
 * (`src/features/databases/properties/text/`) não inclui `e2e/specs/`
 * (onde o critério de DBS-004 aponta, `e2e-webdriverio`) nem
 * `src-tauri/tests/` (onde um `cargo-test` bateria no banco real). Ver o
 * relatório desta peça para o detalhe completo.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { boldSelectionAroundWord } from "./test-support";
import { specForPropertyType, type PropertySpec } from "../../core/property-spec";
import "./register";
import { RICH_TEXT_CELL_EXTENSIONS } from "./RichTextEditor";
import type { InlineTextNode, RichTextConfig, RichTextNode, RichTextValue } from "./rich-text-value";

/** Estreita `RichTextNode` (union fechado de dois tipos) para o caso que carrega texto/marca — sem `as`, o discriminante `type` já basta. */
function isTextNode(node: RichTextNode): node is InlineTextNode {
  return node.type === "text";
}

describe("registro do tipo de propriedade 'text'", () => {
  it("registra com valueShape 'text' (jsonb sempre string, arquitetura §6)", () => {
    const spec = specForPropertyType("text");
    expect(spec?.valueShape).toBe("text");
    expect(spec?.sort).toBe("text");
  });
});

/** O "banco": aqui está a ÚNICA linha que finge ser o Postgres — um round trip de `JSON.stringify`/`JSON.parse`, o que um valor jsonb escalar (string) sofre de verdade ao ser gravado e lido de volta, sem perder byte nenhum. */
function throughFakeJsonbColumn(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("DBS-004 — negrito aplicado a um trecho reaparece idêntico em nova sessão", () => {
  let editorA: Editor | null = null;
  let editorB: Editor | null = null;

  afterEach(() => {
    editorA?.destroy();
    editorB?.destroy();
    editorA = null;
    editorB = null;
  });

  it("digitar, selecionar um trecho, aplicar negrito, salvar e reabrir preserva a marca exatamente", () => {
    // `as`: `specForPropertyType` devolve o spec já "largo" (erasure
    // deliberado no limite do registro, documentado em `property-spec.ts`).
    // Este arquivo é quem registrou "text" sob estes genéricos em
    // `register.ts`, então recuperar o tipo concreto aqui é seguro.
    const spec = specForPropertyType("text") as PropertySpec<RichTextValue, RichTextConfig> | undefined;
    if (!spec) throw new Error("propertyType 'text' não registrado");

    // 1. "Sessão 1": o usuário digita e aplica negrito num trecho, por
    // comandos reais do editor — não um JSON escrito à mão.
    editorA = new Editor({ extensions: RICH_TEXT_CELL_EXTENSIONS, content: { type: "doc", content: [] } });
    editorA.commands.insertContent("Hello world");
    boldSelectionAroundWord(editorA, "world");

    const typed = editorA.getJSON().content ?? [];
    const normalized = spec.normalize(typed, spec.defaultConfig);
    expect(normalized).not.toBeNull();
    if (!normalized) throw new Error("normalize() devolveu null para conteúdo não vazio");

    // 2. Persistência: exatamente o que `apply_record_value_changes` (Rust,
    // I4) grava em `database_record_values.value` — uma string, porque
    // `serialize()` do tipo Texto sempre devolve uma.
    const rawForDb = spec.serialize(normalized);
    expect(typeof rawForDb).toBe("string");

    // 3. "Nova sessão": o valor volta do jsonb (round trip fiel, ver
    // `throughFakeJsonbColumn`) e um SEGUNDO editor, sem relação nenhuma
    // com o primeiro, reconstrói o conteúdo a partir dele.
    const rawFromDb = throughFakeJsonbColumn(rawForDb);
    const reopened = spec.parse(rawFromDb);

    editorB = new Editor({ extensions: RICH_TEXT_CELL_EXTENSIONS, content: { type: "doc", content: reopened } });
    // O editor de verdade aceitou o conteúdo reconstruído sem alterar nada
    // nele — prova que `reopened` é um doc TipTap válido, não só um array
    // que por acaso tem a forma certa.
    expect(editorB.getJSON().content).toEqual(normalized);

    const textNodes = reopened.filter(isTextNode);
    const boldNode = textNodes.find((node) => node.text === "world");
    expect(boldNode?.marks).toEqual([{ type: "bold" }]);
    // O texto sem negrito, do mesmo trecho, continua sem marca nenhuma —
    // prova que a marca ficou no lugar certo, não em tudo.
    const plainNode = textNodes.find((node) => node.text === "Hello ");
    expect(plainNode?.marks ?? []).toHaveLength(0);
  });

  it("o texto achatado da propriedade (busca/CSV) ignora a marca e devolve só as palavras", () => {
    // `as`: mesma justificativa do teste anterior.
    const spec = specForPropertyType("text") as PropertySpec<RichTextValue, RichTextConfig> | undefined;
    if (!spec) throw new Error("propertyType 'text' não registrado");

    editorA = new Editor({ extensions: RICH_TEXT_CELL_EXTENSIONS, content: { type: "doc", content: [] } });
    editorA.commands.insertContent("Hello world");
    boldSelectionAroundWord(editorA, "world");

    const normalized = spec.normalize(editorA.getJSON().content ?? [], spec.defaultConfig);
    expect(spec.toPlainText(normalized, spec.defaultConfig)).toBe("Hello world");
  });
});
