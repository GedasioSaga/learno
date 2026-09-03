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

// Placeholder de teste — nunca uma credencial real, só o que
// `CheckDatabaseSection` manda de volta como `password` para a chamada
// mockada de `checkDatabase` abaixo.
const FAKE_INPUT_FOR_TEST = "x7k9-test-only";

beforeEach(() => {
  checkDatabaseMock.mockReset();
});

// PLT-013: o botão "Verificar banco de dados" fica desabilitado até algo ser
// digitado no campo — o backend precisa dele para o backup pré-reparo, e a
// UI nunca chama `checkDatabase` com o campo vazio (ver `canCheck` no
// componente).
async function fillField(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Senha do Postgres"), FAKE_INPUT_FOR_TEST);
}

describe("CheckDatabaseSection", () => {
  it("mostra que o banco está íntegro quando nada precisou de conserto", async () => {
    const user = userEvent.setup();
    checkDatabaseMock.mockResolvedValue({ orphaned_card_ids: [], total_repaired: 0 });

    render(<CheckDatabaseSection />);
    await fillField(user);
    await user.click(screen.getByRole("button", { name: "Verificar banco de dados" }));

    expect(checkDatabaseMock).toHaveBeenCalledWith(FAKE_INPUT_FOR_TEST);
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
    await fillField(user);
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
    await fillField(user);
    await user.click(screen.getByRole("button", { name: "Verificar banco de dados" }));

    expect(
      await screen.findByText("1 cartão órfão foi removido por não ter nota correspondente."),
    ).toBeInTheDocument();
  });

  it("mostra o erro do backend quando a checagem falha", async () => {
    const user = userEvent.setup();
    checkDatabaseMock.mockRejectedValue(new Error("banco de dados ainda não conectado"));

    render(<CheckDatabaseSection />);
    await fillField(user);
    await user.click(screen.getByRole("button", { name: "Verificar banco de dados" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("banco de dados ainda não conectado");
  });

  // PLT-013: sem nada digitado ali, o backend não teria como fazer o backup
  // antes do reparo — o botão precisa continuar desabilitado, não só deixar
  // de mandar o campo na chamada.
  it("mantém o botão desabilitado enquanto o campo de senha está vazio", () => {
    render(<CheckDatabaseSection />);

    expect(screen.getByRole("button", { name: "Verificar banco de dados" })).toBeDisabled();
    expect(checkDatabaseMock).not.toHaveBeenCalled();
  });

  // Também mostra o erro que o backup em si pode produzir (pg_dump ausente,
  // disco cheio) — chega aqui como qualquer outro erro do backend, sem
  // tratamento especial, e o reparo nem chega a rodar nesse caso.
  it("mostra o erro quando o backup pré-reparo falha e nunca chega a reparar nada", async () => {
    const user = userEvent.setup();
    checkDatabaseMock.mockRejectedValue(
      new Error("pg_dump não encontrado no PATH — instale as ferramentas de cliente do Postgres"),
    );

    render(<CheckDatabaseSection />);
    await fillField(user);
    await user.click(screen.getByRole("button", { name: "Verificar banco de dados" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("pg_dump não encontrado no PATH");
  });
});
