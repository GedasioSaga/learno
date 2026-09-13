import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./ThemeToggle";
import { useThemeStore } from "../lib/theme-store";

// O botão persiste a escolha por IPC; sem runtime Tauri isso rejeitaria, e o
// store engole o erro de propósito. Mockar deixa o teste afirmar QUE persistiu.
vi.mock("../lib/ipc", () => ({
  getTheme: vi.fn().mockResolvedValue(null),
  saveTheme: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  useThemeStore.setState({
    preferencia: "ambar-noturno",
    temaEfetivo: "ambar-noturno",
    ultimoEscuro: "ambar-noturno",
  });
});

describe("ThemeToggle", () => {
  it("no escuro, oferece ir para o claro — e o rótulo diz o destino, não o estado", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const botao = screen.getByRole("button", { name: "Tema claro" });
    await user.click(botao);

    expect(document.documentElement.dataset.theme).toBe("papel");
    expect(screen.getByRole("button", { name: "Tema escuro" })).toBeInTheDocument();
  });

  it("voltar do claro devolve o escuro que estava em uso, não o padrão de fábrica", async () => {
    // Quem estava em Meia-noite e deu uma passada pelo claro espera Meia-noite
    // de volta — não Âmbar noturno. É o ponto inteiro de guardar `ultimoEscuro`.
    useThemeStore.setState({
      preferencia: "meia-noite",
      temaEfetivo: "meia-noite",
      ultimoEscuro: "meia-noite",
    });
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: /Tema claro/ }));
    expect(document.documentElement.dataset.theme).toBe("papel");

    await user.click(screen.getByRole("button", { name: /Tema escuro/ }));
    expect(document.documentElement.dataset.theme).toBe("meia-noite");
  });

  it("diz para onde vai no title, para quem passa o mouse antes de clicar", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute("title", "Alternar para Papel");
  });
});
