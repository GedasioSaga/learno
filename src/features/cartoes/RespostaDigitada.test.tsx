import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RespostaDigitada } from "./RespostaDigitada";

describe("RespostaDigitada", () => {
  it("resposta certa: chama onEnviar(true)", async () => {
    const user = userEvent.setup();
    const onEnviar = vi.fn();
    render(<RespostaDigitada esperado="mitocôndria" revelado={false} onEnviar={onEnviar} />);

    await user.type(screen.getByLabelText("Sua resposta"), "mitocôndria");
    await user.click(screen.getByRole("button", { name: "Conferir" }));

    expect(onEnviar).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("resposta errada: chama onEnviar(false)", async () => {
    const user = userEvent.setup();
    const onEnviar = vi.fn();
    render(<RespostaDigitada esperado="mitocôndria" revelado={false} onEnviar={onEnviar} />);

    await user.type(screen.getByLabelText("Sua resposta"), "núcleo");
    await user.click(screen.getByRole("button", { name: "Conferir" }));

    expect(onEnviar).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("campo vazio: ainda envia, sem bloquear (vazio é resposta errada válida)", async () => {
    const user = userEvent.setup();
    const onEnviar = vi.fn();
    render(<RespostaDigitada esperado="mitocôndria" revelado={false} onEnviar={onEnviar} />);

    await user.click(screen.getByRole("button", { name: "Conferir" }));

    expect(onEnviar).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("Enter dentro do campo faz a mesma coisa que o botão Conferir", async () => {
    const user = userEvent.setup();
    const onEnviar = vi.fn();
    render(<RespostaDigitada esperado="mitocôndria" revelado={false} onEnviar={onEnviar} />);

    await user.type(screen.getByLabelText("Sua resposta"), "mitocôndria{Enter}");

    expect(onEnviar).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("revelado=false: mostra o campo e não mostra o diff", () => {
    render(<RespostaDigitada esperado="mitocôndria" revelado={false} onEnviar={vi.fn()} />);

    expect(screen.getByLabelText("Sua resposta")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("revelado=true: o campo some e aparece o diff, com o pedaço errado marcado", () => {
    render(<RespostaDigitada esperado="mitocôndria" revelado={true} onEnviar={vi.fn()} />);

    expect(screen.queryByLabelText("Sua resposta")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conferir" })).not.toBeInTheDocument();

    const resultado = screen.getByRole("status");
    expect(resultado).toBeInTheDocument();
    // Sem nada digitado, todo o esperado falta: cada caractere vira um pedaço
    // "faltando", sublinhado (o par não-cromático do status).
    const faltando = resultado.querySelector(".underline");
    expect(faltando).not.toBeNull();
    expect(faltando?.textContent).toBe("mitocôndria");

    expect(screen.getByText("Resposta: mitocôndria")).toBeInTheDocument();
  });

  it("revelado=true: pedaço trocado (errado) e pedaço extra (sobrando) também usam line-through, não só cor", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RespostaDigitada esperado="mitocôndria" revelado={false} onEnviar={vi.fn()} />,
    );
    await user.type(screen.getByLabelText("Sua resposta"), "mitocondria!");
    rerender(<RespostaDigitada esperado="mitocôndria" revelado={true} onEnviar={vi.fn()} />);

    const resultado = screen.getByRole("status");
    // "o" no lugar de "ô" vira uma troca (status "errado"); o "!" sobrando no
    // fim vira "sobrando". Os dois compartilham a classe `line-through` — é
    // o par não-cromático que a cor sozinha não garante.
    const riscados = resultado.querySelectorAll(".line-through");
    expect(riscados).toHaveLength(2);
    expect(riscados[0].textContent).toBe("o");
    expect(riscados[1].textContent).toBe("!");
  });
});
