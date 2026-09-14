import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { abrirPastaDeLogs, registrarErroDaInterface } from "../lib/ipc";
import { esquecerUltimoErro } from "../lib/registro-de-erros";
import { LimiteDeErroGlobal } from "./LimiteDeErroGlobal";

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return { ...actual, abrirPastaDeLogs: vi.fn(), registrarErroDaInterface: vi.fn() };
});

const abrirMock = vi.mocked(abrirPastaDeLogs);
const registrarMock = vi.mocked(registrarErroDaInterface);

function ComponenteQueQuebra(): never {
  throw new Error("componente quebrou");
}

beforeEach(() => {
  abrirMock.mockReset();
  registrarMock.mockReset();
  registrarMock.mockResolvedValue(undefined);
  esquecerUltimoErro();
  // O React escreve o erro capturado no console; aqui ele é esperado.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LimiteDeErroGlobal", () => {
  it("sem erro, mostra o app normalmente", () => {
    render(
      <LimiteDeErroGlobal>
        <p>tudo certo</p>
      </LimiteDeErroGlobal>,
    );

    expect(screen.getByText("tudo certo")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Algo deu errado" })).not.toBeInTheDocument();
  });

  it("erro de renderização troca a tela e grava no log com a pilha dos componentes", async () => {
    render(
      <LimiteDeErroGlobal>
        <ComponenteQueQuebra />
      </LimiteDeErroGlobal>,
    );

    expect(screen.getByRole("heading", { name: "Algo deu errado" })).toBeInTheDocument();
    await waitFor(() =>
      expect(registrarMock).toHaveBeenCalledWith(
        "tela",
        "Error: componente quebrou",
        expect.stringContaining("ComponenteQueQuebra"),
      ),
    );
  });

  it("Copiar detalhes põe mensagem e pilha na área de transferência", async () => {
    // `userEvent.setup()` instala a própria área de transferência no
    // `navigator`; ler dela depois é o que prova o que foi copiado.
    const user = userEvent.setup();
    render(
      <LimiteDeErroGlobal>
        <ComponenteQueQuebra />
      </LimiteDeErroGlobal>,
    );

    await user.click(screen.getByRole("button", { name: "Copiar detalhes" }));

    expect(await screen.findByRole("button", { name: "Copiado" })).toBeInTheDocument();
    const copiado = await navigator.clipboard.readText();
    expect(copiado).toContain("Error: componente quebrou");
    expect(copiado).toContain("ComponenteQueQuebra");
  });

  it("Abrir pasta de logs chama o backend e mostra o motivo quando falha", async () => {
    abrirMock.mockRejectedValueOnce(new Error("explorador indisponível"));
    const user = userEvent.setup();
    render(
      <LimiteDeErroGlobal>
        <ComponenteQueQuebra />
      </LimiteDeErroGlobal>,
    );

    await user.click(screen.getByRole("button", { name: "Abrir pasta de logs" }));

    expect(abrirMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("explorador indisponível");
  });

  it("Recarregar recarrega a janela", async () => {
    const recarregar = vi.fn();
    const user = userEvent.setup();
    render(
      <LimiteDeErroGlobal recarregar={recarregar}>
        <ComponenteQueQuebra />
      </LimiteDeErroGlobal>,
    );

    await user.click(screen.getByRole("button", { name: "Recarregar" }));

    expect(recarregar).toHaveBeenCalledTimes(1);
  });

  // A trava da ligação: sem isto, o limite e o registro podiam existir, testados,
  // e nunca envolver o app de verdade.
  it("o app de verdade monta dentro do limite, com o registro de erros ligado", () => {
    const main = fs.readFileSync(path.resolve(__dirname, "../main.tsx"), "utf-8");

    expect(main).toMatch(/<LimiteDeErroGlobal>\s*<App \/>\s*<\/LimiteDeErroGlobal>/);
    expect(main).toMatch(/^instalarRegistroDeErros\(\);$/m);
  });
});
