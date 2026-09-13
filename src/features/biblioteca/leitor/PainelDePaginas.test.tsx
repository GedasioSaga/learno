import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AppError,
  criarPaginaDeLivro,
  escreverConteudoDaPagina,
  listarPaginasDoLivro,
  moverPaginaDeLivro,
  removerPaginaDeLivro,
  renomearPaginaDeLivro,
  type PaginaDeLivro,
} from "../../../lib/ipc";
import { PainelDePaginas } from "./PainelDePaginas";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return {
    ...actual,
    listarPaginasDoLivro: vi.fn(),
    criarPaginaDeLivro: vi.fn(),
    renomearPaginaDeLivro: vi.fn(),
    escreverConteudoDaPagina: vi.fn(),
    moverPaginaDeLivro: vi.fn(),
    removerPaginaDeLivro: vi.fn(),
  };
});

const listarMock = vi.mocked(listarPaginasDoLivro);
const criarMock = vi.mocked(criarPaginaDeLivro);
const renomearMock = vi.mocked(renomearPaginaDeLivro);
const escreverMock = vi.mocked(escreverConteudoDaPagina);
const moverMock = vi.mocked(moverPaginaDeLivro);
const removerMock = vi.mocked(removerPaginaDeLivro);

function pagina(overrides: Partial<PaginaDeLivro> = {}): PaginaDeLivro {
  return {
    id: "p1",
    bookId: "livro-1",
    title: "Página 1",
    content: "",
    position: "a0",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listarMock.mockResolvedValue([]);
});

describe("PainelDePaginas", () => {
  it("lista vazia diz o que fazer, não fica em branco", async () => {
    render(<PainelDePaginas livroId="livro-1" />);

    expect(await screen.findByText("Nenhuma página ainda. Crie uma para escrever o que quiser sobre este livro.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Nova página" })).toBeInTheDocument();
  });

  it("criar página passa o título certo para o IPC e a página aparece na lista", async () => {
    const user = userEvent.setup();
    criarMock.mockResolvedValue(pagina({ id: "nova", title: "Viagem a Marte" }));
    render(<PainelDePaginas livroId="livro-1" />);

    await screen.findByRole("button", { name: "+ Nova página" });
    await user.click(screen.getByRole("button", { name: "+ Nova página" }));
    await user.type(screen.getByLabelText("Nome da nova página"), "Viagem a Marte");
    await user.keyboard("{Enter}");

    expect(criarMock).toHaveBeenCalledWith("livro-1", "Viagem a Marte");
    expect(await screen.findByText("Viagem a Marte")).toBeInTheDocument();
  });

  it("escrever salva o conteúdo depois da espera entre teclas, com o argumento certo", async () => {
    listarMock.mockResolvedValue([pagina({ id: "p1", title: "Notas" })]);
    escreverMock.mockResolvedValue(pagina({ id: "p1", title: "Notas", content: "primeira anotação" }));
    render(<PainelDePaginas livroId="livro-1" />);

    // Abre o item com timers DE VERDADE — `findBy*` faz polling com
    // `setTimeout`, que trava para sempre sob timers falsos (eles só andam
    // quando mandados explicitamente). Os falsos só entram depois, isolando
    // exatamente o trecho que depende da espera entre teclas.
    const abrir = await screen.findByRole("button", { name: "Notas" });
    fireEvent.click(abrir);
    const campo = screen.getByLabelText("Conteúdo de Notas");

    vi.useFakeTimers();
    try {
      fireEvent.change(campo, { target: { value: "primeira anotação" } });

      expect(escreverMock).not.toHaveBeenCalled();
      // `act`: o disparo do timer chama `salvar`, que é assíncrona — sem
      // envolver em `act`, o React 19 loga "not wrapped in act(...)" para a
      // atualização de estado que a resposta resolvida dispara.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(escreverMock).toHaveBeenCalledWith("p1", "primeira anotação");
    } finally {
      vi.useRealTimers();
    }
  });

  it("erro ao salvar não apaga o que o usuário digitou — o texto continua na caixa", async () => {
    listarMock.mockResolvedValue([pagina({ id: "p1", title: "Notas" })]);
    escreverMock.mockRejectedValue(new AppError({ kind: "erro", message: "disco cheio" }));
    render(<PainelDePaginas livroId="livro-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Notas" }));
    const campo = screen.getByLabelText("Conteúdo de Notas");

    vi.useFakeTimers();
    try {
      fireEvent.change(campo, { target: { value: "não pode sumir" } });

      // `act` garante que a atualização de estado disparada pela rejeição
      // (o `.catch` de `salvar`) termine de aplicar antes da asserção — sem
      // isto, o React 19 loga "not wrapped in act" e a leitura abaixo corre
      // o risco de pegar a tela de antes do re-render.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // `findBy*` faz polling com `setTimeout` — sob timers falsos ele nunca
      // dispara sozinho. `advanceTimersByTimeAsync` já espera as microtasks
      // da rejeição serem processadas, então o estado já está pronto aqui,
      // e dá pra ler com `getBy*` em vez de esperar de novo.
      expect(screen.getByRole("alert")).toHaveTextContent("disco cheio");
      expect(screen.getByLabelText("Conteúdo de Notas")).toHaveValue("não pode sumir");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renomear age na SEGUNDA de duas páginas, sem tocar na primeira", async () => {
    const user = userEvent.setup();
    listarMock.mockResolvedValue([pagina({ id: "p1", title: "Primeira" }), pagina({ id: "p2", title: "Segunda" })]);
    renomearMock.mockResolvedValue(pagina({ id: "p2", title: "Segunda Renomeada" }));
    render(<PainelDePaginas livroId="livro-1" />);

    await screen.findByRole("button", { name: "Primeira" });
    await user.click(screen.getByRole("button", { name: "Renomear Segunda" }));
    await user.clear(screen.getByLabelText("Nome da página Segunda"));
    await user.type(screen.getByLabelText("Nome da página Segunda"), "Segunda Renomeada");
    await user.keyboard("{Enter}");

    expect(renomearMock).toHaveBeenCalledWith("p2", "Segunda Renomeada");
    expect(await screen.findByText("Segunda Renomeada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Primeira" })).toBeInTheDocument();
  });

  it("remover age na SEGUNDA de duas páginas, sem tocar na primeira", async () => {
    const user = userEvent.setup();
    listarMock.mockResolvedValue([pagina({ id: "p1", title: "Primeira" }), pagina({ id: "p2", title: "Segunda" })]);
    removerMock.mockResolvedValue(undefined);
    render(<PainelDePaginas livroId="livro-1" />);

    await screen.findByRole("button", { name: "Primeira" });
    await user.click(screen.getByRole("button", { name: "Apagar Segunda" }));
    const dialogo = screen.getByRole("alertdialog", { name: "Apagar Segunda?" });
    await user.click(within(dialogo).getByRole("button", { name: "Apagar mesmo assim" }));

    expect(removerMock).toHaveBeenCalledWith("p2");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Segunda" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Primeira" })).toBeInTheDocument();
  });

  it("reordenar funciona por teclado (foco + Enter no botão de mover), não só arrastando", async () => {
    const user = userEvent.setup();
    listarMock.mockResolvedValue([pagina({ id: "p1", title: "Primeira" }), pagina({ id: "p2", title: "Segunda" })]);
    moverMock.mockResolvedValue(pagina({ id: "p2", title: "Segunda", position: "a0" }));
    render(<PainelDePaginas livroId="livro-1" />);

    await screen.findByRole("button", { name: "Primeira" });
    const botaoMoverCima = screen.getByRole("button", { name: "Mover Segunda para cima" });
    botaoMoverCima.focus();
    await user.keyboard("{Enter}");

    expect(moverMock).toHaveBeenCalledWith("p2", null);
  });
});
