import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { montarSecoes } from "../features/navegacao/catalogo";
import { useNavegacaoStore } from "../features/navegacao/store";
import { AppShell } from "./AppShell";

function PainelDeNotas() {
  return <p>painel de notas</p>;
}
function ConteudoDeNotas() {
  return <p>conteúdo de notas</p>;
}
function ConteudoDeHoje() {
  return <p>conteúdo de hoje</p>;
}

// Notas com painel, Hoje sem painel, as outras cinco em construção — a
// combinação que exercita cada ramo da casca.
const SECOES = montarSecoes({
  notas: { Painel: PainelDeNotas, Conteudo: ConteudoDeNotas },
  hoje: { Conteudo: ConteudoDeHoje },
});

beforeEach(() => {
  localStorage.clear();
  useNavegacaoStore.setState({ secaoAtiva: "notas", painelRecolhido: false, ultimaTrocaPor: null });
});

describe("AppShell", () => {
  it("mostra o rail com as sete seções, o painel e o conteúdo da seção ativa, e o rodapé", () => {
    render(<AppShell secoes={SECOES} acoes={<button type="button">Configurações</button>} />);

    const rail = screen.getByRole("navigation", { name: "Seções" });
    expect(within(rail).getAllByRole("listitem")).toHaveLength(7);
    expect(within(rail).getByRole("button", { name: "Notas" })).toHaveAttribute("aria-current", "page");
    expect(within(rail).getByRole("button", { name: "Trilha" })).not.toHaveAttribute("aria-current");

    expect(screen.getByRole("complementary", { name: "Notas" })).toHaveAttribute("data-slot", "painel-da-secao");
    expect(screen.getByText("painel de notas")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("conteúdo de notas");

    expect(within(rail).getByRole("button", { name: "Configurações" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: /tema/i })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Recolher painel" })).toBeInTheDocument();
  });

  it("clicar numa seção troca o conteúdo, marca a aba e anima a entrada", async () => {
    const user = userEvent.setup();
    render(<AppShell secoes={SECOES} />);

    await user.click(screen.getByRole("button", { name: "Hoje" }));

    expect(screen.getByRole("button", { name: "Hoje" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("main")).toHaveTextContent("conteúdo de hoje");
    expect(screen.getByRole("main")).toHaveClass("entrada-de-secao");
    // Hoje não tem painel: nem a coluna nem o botão de recolher aparecem.
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /painel/i })).not.toBeInTheDocument();
  });

  it("seção sem tela mostra o estado em construção com o nome dela", async () => {
    const user = userEvent.setup();
    render(<AppShell secoes={SECOES} />);

    await user.click(screen.getByRole("button", { name: "Cronograma" }));

    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 2, name: "Cronograma" })).toBeInTheDocument();
    expect(within(main).getByText("Em construção")).toBeInTheDocument();
  });

  it("Ctrl+dígito troca de seção pela ordem do rail, sem animar", () => {
    render(<AppShell secoes={SECOES} />);

    fireEvent.keyDown(window, { key: "3", ctrlKey: true });

    expect(useNavegacaoStore.getState().secaoAtiva).toBe("cartoes");
    expect(screen.getByRole("button", { name: "Cartões" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("main")).not.toHaveClass("entrada-de-secao");
  });

  it("Ctrl+dígito fora da faixa, ou com Shift/Alt junto, não faz nada", () => {
    render(<AppShell secoes={SECOES} />);

    fireEvent.keyDown(window, { key: "8", ctrlKey: true });
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    fireEvent.keyDown(window, { key: "3", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "3", ctrlKey: true, altKey: true });
    fireEvent.keyDown(window, { key: "3" });

    expect(useNavegacaoStore.getState().secaoAtiva).toBe("notas");
  });

  it("recolher o painel esconde a coluna e oferece mostrar de novo", async () => {
    const user = userEvent.setup();
    render(<AppShell secoes={SECOES} />);

    await user.click(screen.getByRole("button", { name: "Recolher painel" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("conteúdo de notas");

    await user.click(screen.getByRole("button", { name: "Mostrar painel" }));
    expect(screen.getByRole("complementary", { name: "Notas" })).toBeInTheDocument();
  });

  it("uma seção persistida que a montagem não inclui cai na primeira, em vez de tela vazia", () => {
    useNavegacaoStore.setState({ secaoAtiva: "biblioteca" });
    const soNotas = SECOES.filter((secao) => secao.id === "notas");

    render(<AppShell secoes={soNotas} />);

    expect(screen.getByRole("main")).toHaveTextContent("conteúdo de notas");
  });
});
