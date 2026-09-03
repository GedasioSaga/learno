import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./ThemeToggle";
import { useThemeStore } from "../lib/theme-store";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  useThemeStore.setState({ preference: "system", effective: "light" });
});

describe("ThemeToggle", () => {
  it("começa no tema claro e alterna para escuro ao clicar", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const button = screen.getByRole("button", { name: "Tema claro" });
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);

    expect(screen.getByRole("button", { name: "Tema escuro" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("clicar duas vezes volta ao tema claro", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    expect(screen.getByRole("button", { name: "Tema claro" })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
