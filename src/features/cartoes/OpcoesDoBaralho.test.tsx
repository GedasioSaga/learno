import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AppError,
  getDeckSchedulingOptions,
  setDeckSchedulingOptions,
  type DeckRow,
  type OpcoesDeDeckJson,
} from "../../lib/ipc";
import { OpcoesDoBaralho } from "./OpcoesDoBaralho";
import { PESOS_PADRAO_FSRS6 } from "./opcoes-de-baralho";
import { useCartoesStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return { ...actual, getDeckSchedulingOptions: vi.fn(), setDeckSchedulingOptions: vi.fn() };
});

const getMock = vi.mocked(getDeckSchedulingOptions);
const setMock = vi.mocked(setDeckSchedulingOptions);

const PADRAO: OpcoesDeDeckJson = {
  learning_steps_min: [1, 10],
  relearning_steps_min: [10],
  graduating_interval_dias: 1,
  easy_interval_dias: 4,
  easy_bonus_pct: 130,
  hard_interval_pct: 120,
  lapse_new_interval_percent: 0,
  minimum_interval_dias: 1,
  maximum_interval_dias: 36_500,
  leech_threshold: 8,
  fuzz_habilitado: true,
  agendador: "sm2",
  fsrs_retencao_desejada: 0.9,
  fsrs_pesos: [...PESOS_PADRAO_FSRS6],
};

function deck(id: string, name: string): DeckRow {
  return {
    id,
    parentId: null,
    name,
    options: null,
    position: "1",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCartoesStore.setState({
    deckSelecionadoId: "ingles",
    decksById: new Map([["ingles", deck("ingles", "Inglês")]]),
    tela: "opcoes",
  });
  getMock.mockResolvedValue(PADRAO);
  setMock.mockImplementation((id) => Promise.resolve(deck(id, "Inglês")));
});

describe("OpcoesDoBaralho", () => {
  it("carrega as opções do baralho selecionado e mostra o agendador atual marcado", async () => {
    render(<OpcoesDoBaralho />);

    expect(await screen.findByRole("radio", { name: /SM-2/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /FSRS/ })).not.toBeChecked();
    expect(getMock).toHaveBeenCalledWith("ingles");
    expect(screen.getByRole("heading", { name: "Inglês" })).toBeInTheDocument();
    expect(screen.getByLabelText("Passos de aprendizagem")).toHaveValue("1 10");
  });

  /// A verdade 1 do backend: trocar de agendador não migra cartão nenhum. O
  /// usuário precisa ler isso ANTES de salvar, senão troca, não vê diferença
  /// e conclui que está quebrado.
  it("escolher FSRS avisa que os cartões existentes continuam no SM-2, e abre os controles do FSRS", async () => {
    const user = userEvent.setup();
    render(<OpcoesDoBaralho />);
    await screen.findByRole("radio", { name: /SM-2/ });

    await user.click(screen.getByRole("radio", { name: /FSRS/ }));

    expect(screen.getByRole("status")).toHaveTextContent(/cartões que já existem continuam no SM-2/);
    expect(screen.getByLabelText("Retenção desejada")).toHaveValue("90");
    // Campo que só o SM-2 lê diz isso, em vez de fingir que vale sob FSRS.
    expect(screen.getByLabelText("Intervalo de graduação")).toHaveAccessibleDescription(/O FSRS não usa este valor/);
  });

  it("salva pelo IPC no shape snake_case que o Rust espera, e confirma na tela", async () => {
    const user = userEvent.setup();
    render(<OpcoesDoBaralho />);
    await screen.findByRole("radio", { name: /SM-2/ });

    await user.click(screen.getByRole("radio", { name: /FSRS/ }));
    const passos = screen.getByLabelText("Passos de aprendizagem");
    await user.clear(passos);
    await user.type(passos, "1, 10, 60");
    await user.click(screen.getByRole("button", { name: "Salvar opções" }));

    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "ingles",
        expect.objectContaining({
          agendador: "fsrs",
          learning_steps_min: [1, 10, 60],
          fsrs_retencao_desejada: 0.9,
          fsrs_pesos: [...PESOS_PADRAO_FSRS6],
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Opções salvas.");
    // O que fica na tela é o que foi gravado, normalizado.
    expect(screen.getByLabelText("Passos de aprendizagem")).toHaveValue("1 10 60");
  });

  it("não deixa salvar sem ter mudado nada", async () => {
    render(<OpcoesDoBaralho />);
    await screen.findByRole("radio", { name: /SM-2/ });

    expect(screen.getByRole("button", { name: "Salvar opções" })).toBeDisabled();
  });

  it("valor inválido mostra o erro no próprio campo e não chama o backend", async () => {
    const user = userEvent.setup();
    render(<OpcoesDoBaralho />);
    await screen.findByRole("radio", { name: /SM-2/ });

    const graduacao = screen.getByLabelText("Intervalo de graduação");
    await user.clear(graduacao);
    await user.type(graduacao, "abc");
    await user.click(screen.getByRole("button", { name: "Salvar opções" }));

    expect(graduacao).toHaveAttribute("aria-invalid", "true");
    expect(graduacao).toHaveAccessibleDescription(/número inteiro/);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("pesos colados com quantidade errada são recusados antes de ir ao Rust", async () => {
    const user = userEvent.setup();
    render(<OpcoesDoBaralho />);
    await screen.findByRole("radio", { name: /SM-2/ });
    await user.click(screen.getByRole("radio", { name: /FSRS/ }));
    await user.click(screen.getByText("Parâmetros do modelo"));

    const pesos = screen.getByLabelText("Parâmetros do FSRS");
    await user.clear(pesos);
    await user.type(pesos, "0.1 0.2 0.3");
    await user.click(screen.getByRole("button", { name: "Salvar opções" }));

    expect(pesos).toHaveAccessibleDescription(/exatamente 21/);
    expect(setMock).not.toHaveBeenCalled();

    // "Usar padrões" é o caminho de volta para quem colou errado.
    await user.click(screen.getByRole("button", { name: "Usar padrões do FSRS-6" }));
    expect(pesos).toHaveValue(PESOS_PADRAO_FSRS6.join(" "));
  });

  it("retenção acima de 97 % avisa sobre a carga sem bloquear", async () => {
    const user = userEvent.setup();
    render(<OpcoesDoBaralho />);
    await screen.findByRole("radio", { name: /SM-2/ });
    await user.click(screen.getByRole("radio", { name: /FSRS/ }));

    const retencao = screen.getByLabelText("Retenção desejada");
    await user.clear(retencao);
    await user.type(retencao, "99");

    expect(retencao).toHaveAccessibleDescription(/carga diária/);
    expect(retencao).not.toHaveAttribute("aria-invalid");
  });

  it("mostra o erro do backend em vez de fingir que salvou", async () => {
    // `AppError`, não `Error`: é a forma de todo erro que cruza o IPC, e a
    // única cuja mensagem a tela repassa (convenção de `PainelDePrevisao`).
    setMock.mockRejectedValue(new AppError({ kind: "not_found", message: "baralho não encontrado" }));
    const user = userEvent.setup();
    render(<OpcoesDoBaralho />);
    await screen.findByRole("radio", { name: /SM-2/ });

    await user.click(screen.getByRole("radio", { name: /FSRS/ }));
    await user.click(screen.getByRole("button", { name: "Salvar opções" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("baralho não encontrado");
    expect(screen.queryByText("Opções salvas.")).not.toBeInTheDocument();
  });

  it("'Todos os baralhos' não tem opções: explica, em vez de carregar nada", async () => {
    useCartoesStore.setState({ deckSelecionadoId: null });
    render(<OpcoesDoBaralho />);

    expect(screen.getByText(/Cada baralho tem a sua configuração/)).toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("Voltar devolve ao resumo do baralho", async () => {
    const user = userEvent.setup();
    render(<OpcoesDoBaralho />);
    await screen.findByRole("radio", { name: /SM-2/ });

    await user.click(screen.getByRole("button", { name: "Voltar ao baralho" }));

    expect(useCartoesStore.getState().tela).toBe("resumo");
  });

  it("Voltar com alteração pendente pede confirmação antes de descartar", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<OpcoesDoBaralho />);
    await screen.findByRole("radio", { name: /SM-2/ });

    await user.click(screen.getByRole("radio", { name: /FSRS/ }));
    await user.click(screen.getByRole("button", { name: "Voltar ao baralho" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(useCartoesStore.getState().tela).toBe("opcoes");
  });
});
