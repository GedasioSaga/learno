import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renderiza a barra lateral com o slot da árvore de páginas, o alternador de tema e o conteúdo", () => {
    render(
      <AppShell>
        <p>conteúdo da página</p>
      </AppShell>,
    );

    const pageTreeSlot = screen.getByRole("navigation", { name: "Páginas" });
    expect(pageTreeSlot).toHaveAttribute("data-slot", "page-tree");

    expect(screen.getByRole("button", { name: /tema/i })).toBeInTheDocument();
    expect(screen.getByText("conteúdo da página")).toBeInTheDocument();
    expect(screen.getByText("Learno")).toBeInTheDocument();
  });
});
