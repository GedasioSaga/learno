import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppError, atualizarMateria, criarMateria, listarMaterias, removerMateria, type Materia } from "../../lib/ipc";
import { PainelDeMaterias } from "./PainelDeMaterias";
import { useCronogramaStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    listarMaterias: vi.fn(),
    criarMateria: vi.fn(),
    atualizarMateria: vi.fn(),
    removerMateria: vi.fn(),
  };
});

const listarMateriasMock = vi.mocked(listarMaterias);
const criarMateriaMock = vi.mocked(criarMateria);
const atualizarMateriaMock = vi.mocked(atualizarMateria);
const removerMateriaMock = vi.mocked(removerMateria);

function materia(overrides: Partial<Materia> = {}): Materia {
  return {
    id: "m1",
    name: "Matemática",
    color: "azul",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `materiasStatus: "ready"` faz a guarda de `carregarMaterias` (mesma de
  // `loadNoteTypes`) pular o round-trip no `useEffect` de montagem — os
  // testes controlam a lista direto pelo estado, sem depender de
  // `listarMateriasMock` resolver a tempo.
  useCronogramaStore.setState({
    materias: [materia()],
    materiasStatus: "ready",
  });
});

describe("PainelDeMaterias", () => {
  it("nome vazio não chama o IPC ao criar", async () => {
    const user = userEvent.setup();
    render(<PainelDeMaterias />);

    await user.click(screen.getByRole("button", { name: "Criar matéria" }));

    expect(criarMateriaMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Dê um nome à matéria antes de criar.");
  });

  it("cria a matéria com o nome digitado e a cor escolhida", async () => {
    const user = userEvent.setup();
    criarMateriaMock.mockResolvedValue(materia({ id: "m2", name: "Física", color: "roxo" }));
    render(<PainelDeMaterias />);

    await user.type(screen.getByLabelText("Nova matéria"), "Física");
    const grupoCorNova = screen.getByRole("group", { name: "Cor da nova matéria" });
    await user.click(within(grupoCorNova).getByRole("button", { name: "Roxo" }));
    await user.click(screen.getByRole("button", { name: "Criar matéria" }));

    expect(criarMateriaMock).toHaveBeenCalledWith("Física", "roxo");
  });

  it("renomeia: editar o nome e salvar chama atualizarMateria com o nome novo", async () => {
    const user = userEvent.setup();
    atualizarMateriaMock.mockResolvedValue(materia({ name: "Cálculo" }));
    render(<PainelDeMaterias />);

    await user.click(screen.getByRole("button", { name: "Renomear Matemática" }));
    const input = screen.getByLabelText("Nome da matéria Matemática");
    await user.clear(input);
    await user.type(input, "Cálculo");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(atualizarMateriaMock).toHaveBeenCalledWith("m1", { name: "Cálculo" });
  });

  it("trocar a cor de uma matéria existente chama atualizarMateria com a cor nova", async () => {
    const user = userEvent.setup();
    atualizarMateriaMock.mockResolvedValue(materia({ color: "emerald" }));
    render(<PainelDeMaterias />);

    const grupoDeCor = screen.getByRole("group", { name: "Cor de Matemática" });
    await user.click(within(grupoDeCor).getByRole("button", { name: "Esmeralda" }));

    expect(atualizarMateriaMock).toHaveBeenCalledWith("m1", { color: "emerald" });
  });

  it("remover pede confirmação antes de chamar o IPC, e só remove depois de confirmar", async () => {
    const user = userEvent.setup();
    removerMateriaMock.mockResolvedValue(undefined);
    render(<PainelDeMaterias />);

    await user.click(screen.getByRole("button", { name: "Remover Matemática" }));
    expect(removerMateriaMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Remover Matemática?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remover mesmo assim" }));

    expect(removerMateriaMock).toHaveBeenCalledWith("m1");
  });

  it("cancelar a confirmação de remoção não chama o IPC nem deixa o diálogo aberto", async () => {
    const user = userEvent.setup();
    render(<PainelDeMaterias />);

    await user.click(screen.getByRole("button", { name: "Remover Matemática" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(removerMateriaMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("erro do IPC ao criar vira mensagem visível, sem corromper a lista", async () => {
    const user = userEvent.setup();
    criarMateriaMock.mockRejectedValue(new Error("erro de rede"));
    render(<PainelDeMaterias />);

    await user.type(screen.getByLabelText("Nova matéria"), "Física");
    await user.click(screen.getByRole("button", { name: "Criar matéria" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível criar a matéria.");
    expect(useCronogramaStore.getState().materias).toEqual([materia()]);
  });

  it("erro do backend (AppError) ao confirmar remoção mostra a mensagem real, e a matéria continua na lista", async () => {
    const user = userEvent.setup();
    removerMateriaMock.mockRejectedValue(new AppError({ kind: "conflito", message: "matéria em uso por um bloco" }));
    render(<PainelDeMaterias />);

    await user.click(screen.getByRole("button", { name: "Remover Matemática" }));
    await user.click(screen.getByRole("button", { name: "Remover mesmo assim" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("matéria em uso por um bloco");
    expect(useCronogramaStore.getState().materias).toEqual([materia()]);
  });

  it("sem matéria nenhuma mostra o aviso em vez de uma lista vazia muda", () => {
    useCronogramaStore.setState({ materias: [], materiasStatus: "ready" });
    render(<PainelDeMaterias />);

    expect(screen.getByText("Nenhuma matéria ainda. Crie a primeira acima.")).toBeInTheDocument();
  });

  it("materiasStatus 'error' mostra a mensagem real, nunca o convite de lista vazia", async () => {
    // `materiasStatus: "idle"` (não "ready") pra deixar o `useEffect` de
    // montagem disparar `carregarMaterias()` de verdade e ele falhar — só
    // setar `materiasStatus: "error"" direto no estado inicial não bastaria:
    // a guarda de `carregarMaterias` não bloqueia o status "error", então o
    // efeito de montagem sobrescreveria com "loading" antes da asserção.
    listarMateriasMock.mockRejectedValue(new AppError({ kind: "erro", message: "banco indisponível" }));
    useCronogramaStore.setState({ materias: [], materiasStatus: "idle", materiasErrorMessage: null });
    render(<PainelDeMaterias />);

    expect(await screen.findByRole("alert")).toHaveTextContent("banco indisponível");
    expect(screen.queryByText("Nenhuma matéria ainda. Crie a primeira acima.")).not.toBeInTheDocument();
  });

  it("renomear com nome vazio não chama o IPC (guarda de confirmarRenomeio)", async () => {
    const user = userEvent.setup();
    render(<PainelDeMaterias />);

    await user.click(screen.getByRole("button", { name: "Renomear Matemática" }));
    await user.clear(screen.getByLabelText("Nome da matéria Matemática"));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(atualizarMateriaMock).not.toHaveBeenCalled();
  });

  it("renomear com o mesmo nome não chama o IPC (guarda de confirmarRenomeio)", async () => {
    const user = userEvent.setup();
    render(<PainelDeMaterias />);

    await user.click(screen.getByRole("button", { name: "Renomear Matemática" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(atualizarMateriaMock).not.toHaveBeenCalled();
  });

  it("com duas matérias, agir na segunda linha passa o id dela ao IPC — não o da primeira", async () => {
    const user = userEvent.setup();
    const segunda = materia({ id: "m2", name: "Física", color: "roxo" });
    useCronogramaStore.setState({ materias: [materia(), segunda], materiasStatus: "ready" });
    atualizarMateriaMock.mockResolvedValue(segunda);
    removerMateriaMock.mockResolvedValue(undefined);
    render(<PainelDeMaterias />);

    await user.click(screen.getByRole("button", { name: "Renomear Física" }));
    const input = screen.getByLabelText("Nome da matéria Física");
    await user.clear(input);
    await user.type(input, "Físico-Química");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    expect(atualizarMateriaMock).toHaveBeenCalledWith("m2", { name: "Físico-Química" });

    const grupoDeCor = screen.getByRole("group", { name: "Cor de Física" });
    await user.click(within(grupoDeCor).getByRole("button", { name: "Esmeralda" }));
    expect(atualizarMateriaMock).toHaveBeenCalledWith("m2", { color: "emerald" });

    await user.click(screen.getByRole("button", { name: "Remover Física" }));
    await user.click(screen.getByRole("button", { name: "Remover mesmo assim" }));
    expect(removerMateriaMock).toHaveBeenCalledWith("m2");
  });
});
