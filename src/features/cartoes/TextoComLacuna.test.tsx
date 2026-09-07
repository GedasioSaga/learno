import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ClozeSegment } from "../../lib/ipc";
import { TextoComLacuna, textoDaLacunaParaVoz } from "./TextoComLacuna";

const visivel = (text: string): ClozeSegment => ({ text, hidden: false, hint: null });
const escondido = (text: string, hint: string | null = null): ClozeSegment => ({ text, hidden: true, hint });

const FRASE = [visivel("A capital da França é "), escondido("Paris"), visivel(".")];
const COM_DICA = [visivel("A organela é a "), escondido("mitocôndria", "usina da célula"), visivel(".")];

describe("TextoComLacuna", () => {
  it("na frente, o texto escondido não entra no DOM e a lacuna tem rótulo para leitor de tela", () => {
    render(<TextoComLacuna segmentos={FRASE} numeroDaLacuna={1} revelado={false} extra="" />);

    expect(screen.queryByText("Paris")).not.toBeInTheDocument();
    expect(screen.getByText("lacuna")).toBeInTheDocument();
    expect(screen.getByText("…")).toHaveAttribute("aria-hidden", "true");
  });

  it("a dica aparece no lugar da lacuna, nunca a resposta", () => {
    render(<TextoComLacuna segmentos={COM_DICA} numeroDaLacuna={1} revelado={false} extra="" />);

    expect(screen.getByText("usina da célula")).toBeInTheDocument();
    expect(screen.queryByText("mitocôndria")).not.toBeInTheDocument();
    expect(screen.getByText("lacuna, dica:")).toBeInTheDocument();
  });

  it("revelado, a resposta aparece e a dica some", () => {
    render(<TextoComLacuna segmentos={COM_DICA} numeroDaLacuna={1} revelado extra="" />);

    expect(screen.getByText("mitocôndria")).toBeInTheDocument();
    expect(screen.queryByText("usina da célula")).not.toBeInTheDocument();
    expect(screen.queryByText("lacuna", { exact: false })).not.toBeInTheDocument();
  });

  it("duas ocorrências da mesma lacuna escondem as duas e revelam as duas", () => {
    const segmentos = [escondido("A"), visivel(" e "), escondido("B")];
    const { rerender } = render(<TextoComLacuna segmentos={segmentos} numeroDaLacuna={1} revelado={false} extra="" />);
    expect(screen.getAllByText("lacuna")).toHaveLength(2);
    expect(screen.queryByText("A")).not.toBeInTheDocument();

    rerender(<TextoComLacuna segmentos={segmentos} numeroDaLacuna={1} revelado extra="" />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("o Extra só entra depois de revelar, e só se tiver texto", () => {
    const { rerender } = render(
      <TextoComLacuna segmentos={FRASE} numeroDaLacuna={1} revelado={false} extra="Às margens do Sena." />,
    );
    expect(screen.queryByText("Às margens do Sena.")).not.toBeInTheDocument();

    rerender(<TextoComLacuna segmentos={FRASE} numeroDaLacuna={1} revelado extra="Às margens do Sena." />);
    expect(screen.getByText("Às margens do Sena.")).toBeInTheDocument();
    expect(screen.getByText("Extra")).toBeInTheDocument();

    rerender(<TextoComLacuna segmentos={FRASE} numeroDaLacuna={1} revelado extra="   " />);
    expect(screen.queryByText("Extra")).not.toBeInTheDocument();
  });

  describe("entrada hostil: a sessão nunca cai", () => {
    it("lista sem nenhuma lacuna (nota editada ou marcação quebrada) mostra o texto e avisa qual lacuna faltou", () => {
      render(
        <TextoComLacuna
          segmentos={[visivel("{{c1::sem fechar e {{{{}}}} e {c2::a}}")]}
          numeroDaLacuna={2}
          revelado={false}
          extra=""
        />,
      );

      // O que o parser não reconheceu vem verbatim — é texto, não marcação.
      expect(screen.getByText("{{c1::sem fechar e {{{{}}}} e {c2::a}}")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("lacuna 2");
    });

    it("lista vazia (campo Texto vazio) mostra '(sem conteúdo)', sem aviso de lacuna", () => {
      render(<TextoComLacuna segmentos={[]} numeroDaLacuna={1} revelado={false} extra="" />);

      expect(screen.getByText("(sem conteúdo)")).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("lacuna de texto vazio ({{c1::}}) ainda é uma lacuna visível na frente", () => {
      render(<TextoComLacuna segmentos={[escondido("")]} numeroDaLacuna={1} revelado={false} extra="" />);

      expect(screen.getByText("lacuna")).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("dica com '::' sobrando vem verbatim, como o parser a devolveu", () => {
      render(<TextoComLacuna segmentos={[escondido("a", "b::c")]} numeroDaLacuna={1} revelado={false} extra="" />);

      expect(screen.getByText("b::c")).toBeInTheDocument();
    });
  });
});

describe("textoDaLacunaParaVoz", () => {
  it("antes de revelar lê a dica ou a palavra 'lacuna'; depois, o texto inteiro", () => {
    expect(textoDaLacunaParaVoz(FRASE, false)).toBe("A capital da França é lacuna.");
    expect(textoDaLacunaParaVoz(COM_DICA, false)).toBe("A organela é a usina da célula.");
    expect(textoDaLacunaParaVoz(FRASE, true)).toBe("A capital da França é Paris.");
  });

  it("lista vazia dá frase vazia, sem erro", () => {
    expect(textoDaLacunaParaVoz([], false)).toBe("");
  });
});
