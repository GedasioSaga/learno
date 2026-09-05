/**
 * `FilesCell` (`renderValue`) — I1 (vazio não desenha nada) e o truncamento
 * por densidade que o contrato exige (`grid`/`row` resumem, `card`/`peek`
 * mostram tudo) sem trocar de renderizador.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FileRef } from "../../contract";
import { FilesCell } from "./FilesCell";

function files(count: number): FileRef[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `f${index}`,
    src: `f${index}.pdf`,
    name: `arquivo-${index}.pdf`,
    kind: "file" as const,
  }));
}

describe("FilesCell — I1: vazio não é um valor", () => {
  it("lista vazia não renderiza nada (nem placeholder de '0 arquivos')", () => {
    const { container } = render(<FilesCell value={[]} density="grid" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("FilesCell — densidade muda o truncamento, não o renderizador", () => {
  it("densidade 'grid' mostra até 3 e resume o resto em '+N'", () => {
    render(<FilesCell value={files(5)} density="grid" />);
    expect(screen.getByText("arquivo-0.pdf")).toBeInTheDocument();
    expect(screen.getByText("arquivo-2.pdf")).toBeInTheDocument();
    expect(screen.queryByText("arquivo-3.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("densidade 'card' mostra todos os 5 sem resumo, mesmos dados e mesmo componente", () => {
    render(<FilesCell value={files(5)} density="card" />);
    for (let index = 0; index < 5; index += 1) {
      expect(screen.getByText(`arquivo-${index}.pdf`)).toBeInTheDocument();
    }
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  it("dentro do limite da densidade, não mostra resumo nenhum", () => {
    render(<FilesCell value={files(2)} density="grid" />);
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });
});
