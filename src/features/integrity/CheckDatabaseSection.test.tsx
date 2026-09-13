import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CheckDatabaseSection } from "./CheckDatabaseSection";
import { checkDatabase } from "../../lib/ipc";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    checkDatabase: vi.fn(),
  };
});

const checkDatabaseMock = vi.mocked(checkDatabase);

beforeEach(() => {
  checkDatabaseMock.mockReset();
});

describe("CheckDatabaseSection", () => {
  it("mostra que o banco está íntegro quando nada precisou de conserto", async () => {
    const user = userEvent.setup();
    checkDatabaseMock.mockResolvedValue({ orphaned_card_ids: [], total_repaired: 0 });

    render(<CheckDatabaseSection />);
    await user.click(screen.getByRole("button", { name: "Verificar banco de dados" }));

    expect(checkDatabaseMock).toHaveBeenCalledWith();
    expect(
      await screen.findByText("Nenhum problema encontrado. O banco de dados está íntegro."),
    ).toBeInTheDocument();
  });

  it("relata quantos cartões órfãos foram encontrados e removidos", async () => {
    const user = userEvent.setup();
    checkDatabaseMock.mockResolvedValue({
      orphaned_card_ids: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"],
      total_repaired: 2,
    });

    render(<CheckDatabaseSection />);
    await user.click(screen.getByRole("button", { name: "Verificar banco de dados" }));

    expect(
      await screen.findByText("2 cartões órfãos foram removidos por não ter nota correspondente."),
    ).toBeInTheDocument();
  });

  it("usa singular quando só um cartão órfão é encontrado", async () => {
    const user = userEvent.setup();
    checkDatabaseMock.mockResolvedValue({
      orphaned_card_ids: ["11111111-1111-1111-1111-111111111111"],
      total_repaired: 1,
    });

    render(<CheckDatabaseSection />);
    await user.click(screen.getByRole("button", { name: "Verificar banco de dados" }));

    expect(
      await screen.findByText("1 cartão órfão foi removido por não ter nota correspondente."),
    ).toBeInTheDocument();
  });

  it("mostra o erro do backend quando a checagem falha", async () => {
    const user = userEvent.setup();
    checkDatabaseMock.mockRejectedValue(new Error("banco de dados ainda não conectado"));

    render(<CheckDatabaseSection />);
    await user.click(screen.getByRole("button", { name: "Verificar banco de dados" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("banco de dados ainda não conectado");
  });

  // PLT-013: o reparo apaga linha, então o backend faz um backup (VACUUM
  // INTO) antes de reparar por conta própria — não há mais campo nenhum para
  // o usuário preencher antes de poder clicar, então o botão só fica
  // desabilitado enquanto a checagem está em andamento.
  it("desabilita o botão enquanto a checagem está em andamento", async () => {
    const user = userEvent.setup();
    let resolveCheck: (report: { orphaned_card_ids: string[]; total_repaired: number }) => void = () => {};
    checkDatabaseMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );

    render(<CheckDatabaseSection />);
    const button = screen.getByRole("button", { name: "Verificar banco de dados" });
    expect(button).not.toBeDisabled();

    await user.click(button);
    expect(screen.getByRole("button", { name: "Verificando…" })).toBeDisabled();

    resolveCheck({ orphaned_card_ids: [], total_repaired: 0 });
    await screen.findByText("Nenhum problema encontrado. O banco de dados está íntegro.");
  });

  // Também mostra o erro que o backup pré-reparo em si pode produzir (disco
  // cheio, permissão negada) — chega aqui como qualquer outro erro do
  // backend, sem tratamento especial, e o reparo nem chega a rodar nesse caso.
  it("mostra o erro quando o backup pré-reparo falha e nunca chega a reparar nada", async () => {
    const user = userEvent.setup();
    checkDatabaseMock.mockRejectedValue(
      new Error("não foi possível gravar a cópia de segurança — disco cheio"),
    );

    render(<CheckDatabaseSection />);
    await user.click(screen.getByRole("button", { name: "Verificar banco de dados" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("não foi possível gravar a cópia de segurança");
  });
});
