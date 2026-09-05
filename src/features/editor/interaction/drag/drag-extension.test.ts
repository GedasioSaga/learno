/**
 * EDT-050/EDT-051, camada 2: prova que `BlockDragHandle` de fato liga
 * `dragstart`/`dragover`/`drop` reais a `reorderBlock`/`nestBlockUnderSibling`
 * - o que `node-move.test.ts` (camada 1, chama as funções direto) e
 * `drop-zone.test.ts` (a decisão geométrica isolada, com um retângulo
 * passado à mão) nunca exercitam juntos. jsdom não implementa `DragEvent`
 * nem drag-and-drop de verdade (fora do escopo dele - mesmo motivo que o
 * cabeçalho de `drop-zone.ts` dá para testar geometria como função pura) e
 * todo `getBoundingClientRect()` real volta zerado - por isso os testes
 * abaixo despacham um `Event` genérico com `dataTransfer`/`clientX`/
 * `clientY` enxertados via `Object.defineProperty` (o `type` do evento já
 * basta para o listener que `handleDOMEvents` do ProseMirror registra por
 * nome, não por subclasse) e sobrescrevem `getBoundingClientRect` do
 * wrapper-alvo com `DOMRect.fromRect` para alcançar tanto a metade esquerda
 * (reorder) quanto a direita (nest) do bloco. A prova de gesto de mouse real
 * fim-a-fim, contra o Postgres real, continua em
 * `e2e/specs/drag-blocks.e2e.mjs`.
 */
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildEditorExtensions } from "../../core/extensions";
// Registra `Column`/`ColumnList` no schema antes de qualquer `createEditor`
// deste arquivo - o teste EDT-033 solta um bloco na faixa de colunas, que
// passa por `wrapBlocksInColumns` (`../../blocks/columns/column-commands.ts`)
// e precisa desses tipos de nó existirem. No app real isto é automático
// (`core/Editor.tsx` chama `ensureExtensionsDiscovered()`, que carrega TODO
// `register.ts` antes de montar); `buildEditorExtensions` sozinho não
// dispara essa descoberta - mesma convenção que `blocks/columns/
// column-commands.test.ts` já usa com `import "./register"`.
import "../../blocks/columns/register";
import { BlockDragHandle } from "./drag-extension";

// StarterKit (via `buildEditorExtensions`) traz o `Dropcursor` padrão do
// TipTap, que também escuta `dragover` em `view.dom` - fora do nosso
// controle, mas ainda assim disparado pelos eventos sintéticos abaixo. Ele
// chama `view.posAtCoords` -> `document.elementFromPoint`, que jsdom nunca
// implementou (depende de layout real, o mesmo motivo por trás de todo
// `getBoundingClientRect()` vir zerado aqui). Sem este stub local (isolado
// a este arquivo - vitest cria um jsdom novo por arquivo de teste) o
// `Dropcursor` lançaria antes do nosso próprio plugin decidir qualquer
// coisa; devolver `null` é inofensivo, é só o cursor visual de "vai soltar
// aqui" que fica sem mostrar - EDT-050/EDT-051 não dependem dele.
if (typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null;
}

let editor: Editor;

function createEditor(content: JSONContent): Editor {
  // `BlockDragHandle` entra direto na lista, sem passar por
  // `registerBlockExtension`/o registro global - este arquivo testa a
  // extensão em si, não a descoberta automática (`register.ts` não tem
  // lógica própria: só chama `registerBlockExtension`, nada a testar ali).
  return new Editor({ extensions: [...buildEditorExtensions(), BlockDragHandle], content });
}

function json(): JSONContent {
  return editor.getJSON();
}

/** Ids dos blocos de topo, na ordem em que aparecem sob `doc`. */
function topLevelIds(): (string | undefined)[] {
  return (json().content ?? []).map((wrapper) => wrapper.content?.[0]?.attrs?.id as string | undefined);
}

/** Ids dos filhos aninhados de um wrapper de topo, ou `undefined` se ele não tiver `childBlocks`. */
function childIds(topLevelIndex: number): (string | undefined)[] | undefined {
  const wrapper = json().content?.[topLevelIndex];
  const childBlocks = wrapper?.content?.[1];
  if (childBlocks?.type !== "childBlocks") return undefined;
  return (childBlocks.content ?? []).map((child) => child.content?.[0]?.attrs?.id as string | undefined);
}

function paragraph(id: string, text: string): JSONContent {
  return { type: "paragraph", attrs: { id }, content: [{ type: "text", text }] };
}

function block(...contentNode: JSONContent[]): JSONContent {
  return { type: "block", content: contentNode };
}

function threeSiblings(): JSONContent {
  return {
    type: "doc",
    content: [block(paragraph("a", "A")), block(paragraph("b", "B")), block(paragraph("c", "C"))],
  };
}

afterEach(() => {
  editor?.destroy();
});

function handleFor(blockId: string): HTMLElement {
  const handle = editor.view.dom.querySelector<HTMLElement>(`[data-drag-handle-id="${blockId}"]`);
  if (!handle) throw new Error(`nenhuma alça renderizada para o bloco "${blockId}"`);
  return handle;
}

function wrapperFor(blockId: string): HTMLElement {
  const wrapper = handleFor(blockId).closest<HTMLElement>(".ed-block-wrapper");
  if (!wrapper) throw new Error(`alça de "${blockId}" sem ancestral .ed-block-wrapper`);
  return wrapper;
}

/**
 * Faz o wrapper-alvo responder com um retângulo 100x100 não-zero, nas
 * coordenadas que `dropZoneFor` compara - sem isto todo `getBoundingClientRect()`
 * real do jsdom volta zerado e `dropZoneFor` nunca escolhe "nest" nem
 * "columns" (a guarda `height === 0` de `drop-zone.ts` força sempre a borda
 * superior, "reorder before").
 */
function stubRect(el: HTMLElement): void {
  el.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 100 });
}

/**
 * jsdom não tem `DragEvent` - um `Event` genérico do mesmo `type` já basta,
 * porque `handleDOMEvents` registra o listener pelo nome do evento, não pela
 * subclasse; só os campos que `drag-extension.ts` de fato lê precisam
 * existir, então são enxertados como propriedades próprias.
 */
function fakeDragEvent(
  type: string,
  extra: { dataTransfer?: unknown; clientX?: number; clientY?: number } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(extra)) {
    Object.defineProperty(event, key, { value, configurable: true });
  }
  return event;
}

/**
 * `dataTransfer` mínimo - além do que `drag-extension.ts` lê (`setData`,
 * `effectAllowed`), inclui `files`/`clearData` porque o handler `dragstart`
 * *nativo* do ProseMirror (`prosemirror-view`'s `handlers.dragstart`, que
 * roda para QUALQUER `dragstart` dentro de `view.dom`, plugin nenhum
 * decide isso) sempre lê `event.dataTransfer.files.length` e chama
 * `clearData()` antes de devolver o controle ao nosso plugin - um
 * `DataTransfer` de navegador de verdade sempre tem os dois; sem eles aqui
 * o próprio ProseMirror lança `TypeError` antes do nosso handler decidir
 * qualquer coisa. `drop` nunca consulta `dataTransfer` (o id viaja pelo
 * estado do plugin, não por `dataTransfer.getData` - ver o comentário de
 * `drag-extension.ts` sobre a restrição de navegador em ler `dataTransfer`
 * fora de `dragstart`/`drop`).
 */
function stubDataTransfer(): { setData: () => void; clearData: () => void; effectAllowed: string; files: never[] } {
  return { setData: () => {}, clearData: () => {}, effectAllowed: "", files: [] };
}

/** Simula o gesto completo: alça de `sourceId` até o wrapper de `targetId`, soltando em `(clientX, clientY)` relativo ao retângulo 100x100 que `stubRect` monta para o alvo. */
function dragAndDrop(sourceId: string, targetId: string, clientX: number, clientY: number): void {
  const source = handleFor(sourceId);
  const target = wrapperFor(targetId);
  stubRect(target);

  source.dispatchEvent(fakeDragEvent("dragstart", { dataTransfer: stubDataTransfer() }));
  target.dispatchEvent(fakeDragEvent("dragover", { clientX, clientY }));
  target.dispatchEvent(fakeDragEvent("drop", { clientX, clientY }));
}

describe("BlockDragHandle", () => {
  it("EDT-050/EDT-051: renderiza uma alça por bloco, com role e aria-label, inclusive aninhado", () => {
    editor = createEditor({
      type: "doc",
      content: [block(paragraph("a", "A"), { type: "childBlocks", content: [block(paragraph("a1", "A1"))] })],
    });

    for (const id of ["a", "a1"]) {
      const handle = handleFor(id);
      expect(handle.getAttribute("role")).toBe("button");
      expect(handle.getAttribute("aria-label")).toBe("Arrastar bloco");
      expect(handle.parentElement?.classList.contains("ed-block-wrapper")).toBe(true);
    }
  });

  it("EDT-050: arrasta a alça de C e solta na metade esquerda de B - nova ordem A, C, B", () => {
    editor = createEditor(threeSiblings());

    dragAndDrop("c", "b", 10, 10); // metade esquerda (reorder), metade de cima (before)

    expect(topLevelIds()).toEqual(["a", "c", "b"]);
  });

  it("EDT-051: arrasta a alça de C e solta no interior esquerda/centro de A - C vira filho indentado de A", () => {
    editor = createEditor(threeSiblings());

    // Retângulo 100x100 (stubRect): y=50 é interior (fora das bordas
    // superior/inferior, 30-70), x=50 é interior fora da faixa de colunas
    // (que começa em 76 - ver `drop-zone.ts`) = aninhar.
    dragAndDrop("c", "a", 50, 50);

    expect(topLevelIds()).toEqual(["a", "b"]); // C saiu do nível de topo
    expect(childIds(0)).toEqual(["c"]);
  });

  it("EDT-033: arrasta a alça de C e solta na faixa direita de A - A e C viram colunas lado a lado", () => {
    editor = createEditor(threeSiblings());

    // y=50 interior; x=90 está dentro da faixa de colunas (>= 76 no
    // retângulo 100x100 do stub).
    dragAndDrop("c", "a", 90, 50);

    // "a" e "c" saíram do nível de topo - só o columnList novo (e "b") sobram lá.
    expect(topLevelIds()).toHaveLength(2);
    expect(topLevelIds()).toContain("b");

    const columnListWrapper = (json().content ?? []).find((wrapper) => wrapper.content?.[0]?.type === "columnList");
    if (!columnListWrapper) throw new Error("nenhum columnList encontrado no doc após o drop");
    const columns = columnListWrapper.content?.[1]?.content ?? [];
    expect(columns).toHaveLength(2);
    // `JSONContent.attrs` é tipado `Record<string, any> | undefined` pelo
    // @tiptap/core - o cast só estreita `any` para o formato que
    // `column-nodes.ts`'s `idAttribute` de fato produz (string ou null); se
    // a árvore não tiver essa forma, `expect(...).toBe("a"/"c")` abaixo falha
    // com um valor visivelmente errado, nunca silenciosamente.
    const leftBlockId = columns[0]?.content?.[1]?.content?.[0]?.content?.[0]?.attrs?.id as string | undefined;
    const rightBlockId = columns[1]?.content?.[1]?.content?.[0]?.content?.[0]?.attrs?.id as string | undefined;
    // "a" = alvo (esquerda), "c" = arrastado (direita) - mesma ordem de
    // `wrapBlocksInColumns(editor, targetId, sourceId)`.
    expect(leftBlockId).toBe("a");
    expect(rightBlockId).toBe("c");
  });

  it("dragend cancela o arrasto: um drop sem dragstart novo não reordena nada", () => {
    editor = createEditor(threeSiblings());
    const source = handleFor("c");
    const target = wrapperFor("b");
    stubRect(target);

    source.dispatchEvent(fakeDragEvent("dragstart", { dataTransfer: stubDataTransfer() }));
    source.dispatchEvent(fakeDragEvent("dragend"));
    target.dispatchEvent(fakeDragEvent("drop", { clientX: 10, clientY: 10 }));

    expect(topLevelIds()).toEqual(["a", "b", "c"]); // árvore intacta
  });
});
