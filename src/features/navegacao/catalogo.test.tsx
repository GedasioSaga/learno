import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { atalhoDaSecao, METADADOS_DAS_SECOES, montarSecoes } from "./catalogo";
import { SECAO_IDS } from "./contrato";

describe("catálogo de seções", () => {
  it("tem as sete seções, na ordem do pedido", () => {
    expect(METADADOS_DAS_SECOES.map((secao) => secao.nome)).toEqual([
      "Hoje",
      "Notas",
      "Cartões",
      "Mapa mental",
      "Trilha",
      "Cronograma",
      "Biblioteca",
    ]);
  });

  it("dá a cada seção um atalho Ctrl+1…7 pela ordem do rail", () => {
    expect(SECAO_IDS.map(atalhoDaSecao)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("montarSecoes", () => {
  it("mantém a ordem do catálogo e marca como pronta só quem tem implementação", () => {
    function Conteudo() {
      return <p>conteúdo de cartões</p>;
    }
    const secoes = montarSecoes({ cartoes: { Conteudo } });

    expect(secoes.map((secao) => secao.id)).toEqual([...SECAO_IDS]);
    expect(secoes.map((secao) => secao.estado)).toEqual([
      "em-construcao",
      "em-construcao",
      "pronta",
      "em-construcao",
      "em-construcao",
      "em-construcao",
      "em-construcao",
    ]);
  });

  it("seção pronta sem painel fica com Painel null — a casca usa a largura inteira", () => {
    function Conteudo() {
      return null;
    }
    const [hoje] = montarSecoes({ hoje: { Conteudo } });
    expect(hoje.Painel).toBeNull();
    expect(hoje.Conteudo).toBe(Conteudo);
  });

  it("seção sem implementação ganha o estado em construção com o texto do catálogo", () => {
    const trilha = montarSecoes({}).find((secao) => secao.id === "trilha");
    if (!trilha) throw new Error("trilha sumiu do catálogo");

    render(<trilha.Conteudo />);

    expect(screen.getByRole("heading", { level: 2, name: "Trilha" })).toBeInTheDocument();
    expect(screen.getByText("Em construção")).toBeInTheDocument();
    for (const item of trilha.planejado) {
      expect(screen.getByText(item)).toBeInTheDocument();
    }
  });
});
