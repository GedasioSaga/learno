import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AbasDeCartoes } from "./AbasDeCartoes";

describe("AbasDeCartoes", () => {
  it("mostra as quatro abas, sem Sincronizar, com a ativa anunciada por aria-current", () => {
    render(<AbasDeCartoes telaAtiva="painel" onIrPara={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Baralhos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adicionar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Painel" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Estatísticas" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sincronizar/i })).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Baralhos" })).not.toHaveAttribute("aria-current");
  });

  it("clicar numa aba chama onIrPara com a tela correspondente", async () => {
    const usuario = userEvent.setup();
    const onIrPara = vi.fn();
    render(<AbasDeCartoes telaAtiva="resumo" onIrPara={onIrPara} />);

    await usuario.click(screen.getByRole("button", { name: "Estatísticas" }));

    expect(onIrPara).toHaveBeenCalledWith("estatisticas");
  });

  it("todas as quatro abas são alcançáveis só com Tab, na ordem visual", async () => {
    const usuario = userEvent.setup();
    render(<AbasDeCartoes telaAtiva="resumo" onIrPara={vi.fn()} />);

    await usuario.tab();
    expect(screen.getByRole("button", { name: "Baralhos" })).toHaveFocus();
    await usuario.tab();
    expect(screen.getByRole("button", { name: "Adicionar" })).toHaveFocus();
    await usuario.tab();
    expect(screen.getByRole("button", { name: "Painel" })).toHaveFocus();
    await usuario.tab();
    expect(screen.getByRole("button", { name: "Estatísticas" })).toHaveFocus();
  });
});
