/**
 * `FilesEditor` — a fronteira que DBS-016 realmente exige: um gesto de
 * arrasto de VERDADE sobre o DOM renderizado (não uma função de reordenar
 * testada isolada, que provaria só metade do caminho) chamando `onCommit`
 * com a lista na ordem nova. jsdom não tem `DataTransfer` (verificado:
 * `typeof window.DataTransfer === "undefined"`), então cada teste de
 * arrasto fornece seu próprio objeto `dataTransfer` mínimo — é o padrão
 * documentado da própria Testing Library para DnD, não uma simplificação
 * desta peça.
 *
 * O que fica de fora daqui (registrado no relatório): o round-trip via IPC
 * real (`apply_record_value_changes`) e via uma view de Tabela/Board de
 * verdade — nenhuma das duas existe nesta rodada da Fase 3 (ver
 * `divergencias_da_arquitetura`). Este teste prova a metade do "recarregar"
 * que esta peça possui: arrastar -> `onCommit` -> `normalize`/`serialize`/
 * `parse` (fechado em `files-property-spec.test.ts`) devolvem a MESMA ordem.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileRef } from "../../contract";
import { FilesEditor } from "./FilesEditor";

const primeira: FileRef = { id: "primeira", src: "hash-a.png", name: "primeira.png", kind: "image" };
const segunda: FileRef = { id: "segunda", src: "hash-b.png", name: "segunda.png", kind: "image" };
const terceira: FileRef = { id: "terceira", src: "hash-c.pdf", name: "terceira.pdf", kind: "file" };

function makeDataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(() => ""), dropEffect: "", effectAllowed: "" };
}

/**
 * jsdom não implementa `DragEvent` (só `Event`/`MouseEvent`/`UIEvent`) —
 * verificado: `new window.DragEvent(...)` lança `TypeError`. O `fireEvent`
 * da Testing Library cai para `window.Event` nesse caso e SÓ trata
 * `dataTransfer`/`clipboardData` como propriedades especiais; `clientY`
 * passado em `init` é descartado em silêncio (`event.clientY` fica
 * `undefined`, e `undefined - 0 < 20` é sempre `false` — TODA zona vira
 * "after", nunca "before", não importa o valor pedido). Por isso o zoneamento
 * por posição do ponteiro só é testável criando o evento com `createEvent` e
 * definindo `clientY` na instância antes de disparar.
 */
function fireDrag(
  type: "dragStart" | "dragOver" | "drop" | "dragEnd",
  element: Element,
  opts: { dataTransfer: ReturnType<typeof makeDataTransfer>; clientY?: number },
) {
  const event = createEvent[type](element, { dataTransfer: opts.dataTransfer });
  if (opts.clientY !== undefined) {
    Object.defineProperty(event, "clientY", { value: opts.clientY, configurable: true });
  }
  fireEvent(element, event);
}

beforeEach(() => {
  // jsdom não faz layout de verdade — sem isto, toda linha mede 0x0 e
  // `zoneFromPointerY` (que decide antes/depois pela posição Y dentro da
  // linha) sempre cairia no mesmo lado. Fixa cada linha em 40px de altura,
  // começando em y=0, para os testes escolherem a zona com `clientY`.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    top: 0,
    left: 0,
    right: 100,
    bottom: 40,
    width: 100,
    height: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

describe("FilesEditor — arrastar reordena e persiste via onCommit (DBS-016)", () => {
  it("arrastar a segunda linha para a METADE DE CIMA da primeira ('antes') chama onCommit com [segunda, primeira]", () => {
    const onCommit = vi.fn<(next: FileRef[]) => void>();
    render(<FilesEditor value={[primeira, segunda]} onCommit={onCommit} />);

    const [rowPrimeira, rowSegunda] = screen.getAllByRole("listitem");
    const dataTransfer = makeDataTransfer();

    fireDrag("dragStart", rowSegunda, { dataTransfer });
    fireDrag("dragOver", rowPrimeira, { dataTransfer, clientY: 5 }); // 5 < 40/2 => "before"
    fireDrag("drop", rowPrimeira, { dataTransfer, clientY: 5 });
    fireDrag("dragEnd", rowSegunda, { dataTransfer });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toEqual([segunda, primeira]);
  });

  it("arrastar a primeira linha para a METADE DE BAIXO da terceira ('depois') move ela para o fim", () => {
    const onCommit = vi.fn<(next: FileRef[]) => void>();
    render(<FilesEditor value={[primeira, segunda, terceira]} onCommit={onCommit} />);

    const [rowPrimeira, , rowTerceira] = screen.getAllByRole("listitem");
    const dataTransfer = makeDataTransfer();

    fireDrag("dragStart", rowPrimeira, { dataTransfer });
    fireDrag("dragOver", rowTerceira, { dataTransfer, clientY: 35 }); // 35 > 40/2 => "after"
    fireDrag("drop", rowTerceira, { dataTransfer, clientY: 35 });

    expect(onCommit.mock.calls[0][0]).toEqual([segunda, terceira, primeira]);
  });

  it("soltar sobre a própria linha arrastada não chama onCommit — não há reordenação nenhuma para gravar", () => {
    const onCommit = vi.fn<(next: FileRef[]) => void>();
    render(<FilesEditor value={[primeira, segunda]} onCommit={onCommit} />);

    const [rowPrimeira] = screen.getAllByRole("listitem");
    const dataTransfer = makeDataTransfer();
    fireDrag("dragStart", rowPrimeira, { dataTransfer });
    fireDrag("drop", rowPrimeira, { dataTransfer, clientY: 5 });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("botões 'mover para cima/baixo' são a alternativa por teclado ao arrasto e produzem a MESMA reordenação", () => {
    const onCommit = vi.fn<(next: FileRef[]) => void>();
    render(<FilesEditor value={[primeira, segunda]} onCommit={onCommit} />);

    fireEvent.click(screen.getByRole("button", { name: "Mover segunda.png para cima" }));

    expect(onCommit.mock.calls[0][0]).toEqual([segunda, primeira]);
  });

  it("'mover para cima' na primeira linha e 'mover para baixo' na última ficam desabilitados (não há para onde ir)", () => {
    render(<FilesEditor value={[primeira, segunda]} onCommit={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Mover primeira.png para cima" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mover segunda.png para baixo" })).toBeDisabled();
  });
});

describe("FilesEditor — remover (I1: a lista pode esvaziar de volta)", () => {
  it("remover o único arquivo chama onCommit com lista vazia — o spec.normalize() dessa lista é o que apaga a linha (I1), não este componente", () => {
    const onCommit = vi.fn<(next: FileRef[]) => void>();
    render(<FilesEditor value={[primeira]} onCommit={onCommit} />);

    fireEvent.click(screen.getByRole("button", { name: "Remover primeira.png" }));

    expect(onCommit).toHaveBeenCalledWith([]);
  });
});

describe("FilesEditor — anexar reusa storeMediaFile de verdade (não reimplementa storage de mídia)", () => {
  it("um arquivo escolhido de verdade entra na lista com o src que storeMediaFile devolveu, kind classificado pelo MIME", async () => {
    const onCommit = vi.fn<(next: FileRef[]) => void>();
    const { container } = render(<FilesEditor value={[primeira]} onCommit={onCommit} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("input de arquivo não encontrado no DOM");

    const file = new File(["conteúdo"], "novo.png", { type: "image/png" });
    const user = userEvent.setup();
    await user.upload(input, file);

    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0][0];
    expect(committed).toHaveLength(2);
    expect(committed[0]).toEqual(primeira);
    expect(committed[1].name).toBe("novo.png");
    expect(committed[1].kind).toBe("image");
    // Fora do Tauri, `storeMediaFile` devolve uma chave de sessão
    // "blob:<uuid><extensão>" (`media-storage.ts`) — o valor exato não é
    // fabricado aqui, é lido de volta do `onCommit` real.
    expect(committed[1].src).toMatch(/^blob:.+\.png$/);
  });

  it("arquivo vazio (0 bytes) é recusado por validateMediaFile e aparece como alerta, sem chamar onCommit", async () => {
    const onCommit = vi.fn<(next: FileRef[]) => void>();
    const { container } = render(<FilesEditor value={[]} onCommit={onCommit} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("input de arquivo não encontrado no DOM");

    const empty = new File([], "vazio.png", { type: "image/png" });
    const user = userEvent.setup();
    await user.upload(input, empty);

    expect(onCommit).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("vazio.png");
  });
});
