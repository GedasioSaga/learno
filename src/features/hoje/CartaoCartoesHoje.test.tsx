import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { deckCounts } from "../../lib/ipc";
import { SECAO_PADRAO, useNavegacaoStore } from "../navegacao";
import { CartaoCartoesHoje } from "./CartaoCartoesHoje";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    deckCounts: vi.fn(),
  };
});

const deckCountsMock = vi.mocked(deckCounts);

beforeEach(() => {
  deckCountsMock.mockReset();
  localStorage.clear();
  useNavegacaoStore.setState({ secaoAtiva: SECAO_PADRAO, painelRecolhido: false, ultimaTrocaPor: null });
});

describe("CartaoCartoesHoje", () => {
  it("mostra o total (novos + aprendendo + revisar) e o botão para estudar", async () => {
    deckCountsMock.mockResolvedValue({ novos: 10, aprendendo: 3, revisar: 1 });

    render(<CartaoCartoesHoje />);

    expect(await screen.findByText("14")).toBeInTheDocument();
    expect(deckCountsMock).toHaveBeenCalledWith();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Estudar agora" })).toBeInTheDocument();
  });

  it("sem nada vencendo, mostra 0 de verdade e nenhum botão de estudar", async () => {
    deckCountsMock.mockResolvedValue({ novos: 0, aprendendo: 0, revisar: 0 });

    render(<CartaoCartoesHoje />);

    // `{ selector: "p" }` isola o total (um `<p>`) dos três `<dd>0</dd>` do
    // detalhamento — ver o mesmo recurso em `Breadcrumb.test.tsx` para o
    // mesmo problema (texto repetido em papéis diferentes da tela).
    expect(await screen.findByText("0", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("Nada para estudar agora.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Estudar agora" })).not.toBeInTheDocument();
  });

  it("clicar em Estudar agora leva a seção Cartões", async () => {
    const user = userEvent.setup();
    deckCountsMock.mockResolvedValue({ novos: 5, aprendendo: 0, revisar: 0 });

    render(<CartaoCartoesHoje />);

    await user.click(await screen.findByRole("button", { name: "Estudar agora" }));

    expect(useNavegacaoStore.getState().secaoAtiva).toBe("cartoes");
  });

  it("mostra um erro em vez de travar em 'Carregando…'", async () => {
    // Não é `AppError` (o formato que o backend manda por `invoke`) — cai na
    // mensagem padrão, em vez de expor um erro cru de JS ao usuário; ver
    // `mensagemDoErro`/`messageFor` no restante do app para o mesmo critério.
    deckCountsMock.mockRejectedValue(new Error("boom"));

    render(<CartaoCartoesHoje />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os cartões de hoje.");
  });
});
