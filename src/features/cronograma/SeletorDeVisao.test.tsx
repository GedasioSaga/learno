import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SeletorDeVisao } from "./SeletorDeVisao";
import { useCronogramaStore } from "./store";

beforeEach(() => {
  window.localStorage.clear();
  useCronogramaStore.setState({ visao: "colunas" });
});

describe("SeletorDeVisao", () => {
  it("começa com 'Colunas' marcado e 'Grade' não", () => {
    render(<SeletorDeVisao />);

    expect(screen.getByRole("button", { name: "Colunas" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Grade" })).toHaveAttribute("aria-pressed", "false");
  });

  it("clicar em 'Grade' troca a visão no store e marca o botão", async () => {
    const user = userEvent.setup();
    render(<SeletorDeVisao />);

    await user.click(screen.getByRole("button", { name: "Grade" }));

    expect(useCronogramaStore.getState().visao).toBe("grade");
    expect(screen.getByRole("button", { name: "Grade" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Colunas" })).toHaveAttribute("aria-pressed", "false");
  });
});
