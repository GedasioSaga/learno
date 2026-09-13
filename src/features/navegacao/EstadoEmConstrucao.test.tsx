import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EstadoEmConstrucao } from "./EstadoEmConstrucao";
import { IconeTrilha } from "./icones";

describe("EstadoEmConstrucao", () => {
  it("diz o nome, o que vai ser, o que está planejado e que nada é dado real", () => {
    render(
      <EstadoEmConstrucao
        nome="Previsão de revisões"
        descricao="Quantos cartões vencem em cada um dos próximos dias."
        planejado={["Sete dias à frente", "Por baralho ou coleção inteira"]}
        icone={<IconeTrilha />}
      />,
    );

    expect(screen.getByRole("region", { name: "Previsão de revisões" })).toBeInTheDocument();
    expect(screen.getByText("Em construção")).toBeInTheDocument();
    expect(screen.getByText("Quantos cartões vencem em cada um dos próximos dias.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "O que está planejado" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/Nada nesta tela é dado seu ainda/)).toBeInTheDocument();
  });

  it("sem planejado e sem ícone, mostra só o essencial — nenhuma lista vazia, nenhum selo em branco", () => {
    render(<EstadoEmConstrucao nome="Biblioteca" descricao="PDFs e EPUBs." />);

    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(document.querySelector("svg")).toBeNull();
  });

  it("duas instâncias na mesma tela (como Trilha e Cronograma lado a lado em Hoje) não colidem de id, e cada `aria-labelledby` aponta pro título certo", () => {
    render(
      <>
        <EstadoEmConstrucao nome="Trilha" descricao="Descrição da Trilha." />
        <EstadoEmConstrucao nome="Cronograma" descricao="Descrição do Cronograma." />
      </>,
    );

    const trilha = screen.getByRole("region", { name: "Trilha" });
    const cronograma = screen.getByRole("region", { name: "Cronograma" });
    expect(trilha).not.toBe(cronograma);

    const idTrilha = trilha.getAttribute("aria-labelledby");
    const idCronograma = cronograma.getAttribute("aria-labelledby");
    expect(idTrilha).not.toBeNull();
    expect(idTrilha).not.toBe(idCronograma);
    // Um id repetido no DOM é HTML inválido mesmo que os testes de `name`
    // acima "acertem" por sorte de ordem — por isso a checagem extra abaixo.
    expect(document.querySelectorAll(`#${CSS.escape(idTrilha ?? "")}`)).toHaveLength(1);
  });
});
