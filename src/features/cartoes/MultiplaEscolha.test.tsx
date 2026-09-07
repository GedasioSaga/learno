import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MultiplaEscolha } from "./MultiplaEscolha";

/** Texto de um botão sem o prefixo "(n)" nem o sufixo de resultado ("✓ Certa" etc.). */
function textoDaAlternativa(botao: HTMLElement): string {
  return (botao.textContent ?? "").replace(/^\(\d\)/, "").replace(/(✓ Certa|✗ Sua resposta)$/, "");
}

describe("MultiplaEscolha — embaralhamento estável", () => {
  it("a mesma cartaoId produz a mesma ordem em dois renders diferentes", () => {
    const props = {
      correta: "Paris",
      erradas: ["Lyon", "Nice", "Marselha"],
      escolhida: null,
      onEscolher: () => {},
    };

    const primeiro = render(<MultiplaEscolha {...props} cartaoId="cartao-fixo" />);
    const ordem1 = within(primeiro.container)
      .getAllByRole("button")
      .map(textoDaAlternativa);
    primeiro.unmount();

    const segundo = render(<MultiplaEscolha {...props} cartaoId="cartao-fixo" />);
    const ordem2 = within(segundo.container)
      .getAllByRole("button")
      .map(textoDaAlternativa);
    segundo.unmount();

    expect(ordem2).toEqual(ordem1);
  });

  it("cartaoId diferente produz ordem diferente (não é sempre a mesma sequência)", () => {
    const props = {
      correta: "Paris",
      erradas: ["Lyon", "Nice", "Marselha"],
      escolhida: null,
      onEscolher: () => {},
    };

    const ordens = ["cartao-a", "cartao-b", "cartao-c", "cartao-d", "cartao-e"].map((cartaoId) => {
      const { container, unmount } = render(<MultiplaEscolha {...props} cartaoId={cartaoId} />);
      const ordem = within(container).getAllByRole("button").map(textoDaAlternativa);
      unmount();
      return ordem.join(",");
    });

    // Comparamos várias em vez de só duas para não depender de um par
    // específico não colidir por acaso no hash — basta UMA divergir.
    expect(new Set(ordens).size).toBeGreaterThan(1);
  });
});

describe("MultiplaEscolha — escolha e feedback", () => {
  it("onEscolher recebe acertou=true só quando a alternativa clicada é a correta", () => {
    const onEscolher = vi.fn();
    render(
      <MultiplaEscolha
        correta="Paris"
        erradas={["Lyon", "Nice", "Marselha"]}
        cartaoId="carta-1"
        escolhida={null}
        onEscolher={onEscolher}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Lyon/ }));
    expect(onEscolher).toHaveBeenCalledWith("Lyon", false);

    fireEvent.click(screen.getByRole("button", { name: /Paris/ }));
    expect(onEscolher).toHaveBeenCalledWith("Paris", true);
  });

  it("depois de escolhida (prop não-nula), todos os botões ficam desabilitados", () => {
    render(
      <MultiplaEscolha
        correta="Paris"
        erradas={["Lyon", "Nice", "Marselha"]}
        cartaoId="carta-1"
        escolhida="Lyon"
        onEscolher={() => {}}
      />,
    );

    for (const botao of screen.getAllByRole("button")) {
      expect(botao).toBeDisabled();
    }
    // Certo/errado não pode ser só cor: o texto do próprio botão já diz.
    expect(screen.getByRole("button", { name: /Paris/ })).toHaveTextContent("✓ Certa");
    expect(screen.getByRole("button", { name: /Lyon/ })).toHaveTextContent("✗ Sua resposta");
    expect(screen.getByRole("status")).toHaveTextContent("Errado. A resposta certa era: Paris");
  });

  it("escolha correta: o status anuncia acerto", () => {
    render(
      <MultiplaEscolha
        correta="Paris"
        erradas={["Lyon", "Nice", "Marselha"]}
        cartaoId="carta-1"
        escolhida="Paris"
        onEscolher={() => {}}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Certo.");
  });
});

describe("MultiplaEscolha — caso degenerado (só a Correta preenchida)", () => {
  it("renderiza a única alternativa e avisa que não há o que escolher de verdade, sem quebrar", () => {
    render(
      <MultiplaEscolha
        correta="Paris"
        erradas={["", "   ", ""]}
        cartaoId="carta-1"
        escolhida={null}
        onEscolher={() => {}}
      />,
    );

    const botoes = screen.getAllByRole("button");
    expect(botoes).toHaveLength(1);
    expect(botoes[0]).toHaveTextContent("Paris");
    expect(screen.getByText(/só uma opção cadastrada/)).toBeInTheDocument();
  });

  it("com exatamente 1 errada válida (fronteira do <= 1), não avisa e mostra 2 botões", () => {
    render(
      <MultiplaEscolha
        correta="Paris"
        erradas={["Lyon", "", ""]}
        cartaoId="carta-1"
        escolhida={null}
        onEscolher={() => {}}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByText(/só uma opção cadastrada/)).not.toBeInTheDocument();
  });

  it("remove de `erradas` qualquer texto igual à `correta` (dado malformado do card)", () => {
    render(
      <MultiplaEscolha
        correta="Paris"
        erradas={["Paris", "Lyon", ""]}
        cartaoId="carta-1"
        escolhida="Lyon"
        onEscolher={() => {}}
      />,
    );

    // Sem o dedup, as duas alternativas "Paris" ficariam marcadas como
    // certas ao mesmo tempo — aqui deve sobrar só uma.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getAllByText("✓ Certa")).toHaveLength(1);
  });
});

describe("MultiplaEscolha — teclado", () => {
  it("teclas 1 a 4 escolhem a alternativa da posição correspondente enquanto escolhida é null", () => {
    const onEscolher = vi.fn();
    render(
      <MultiplaEscolha
        correta="Paris"
        erradas={["Lyon", "Nice", "Marselha"]}
        cartaoId="carta-1"
        escolhida={null}
        onEscolher={onEscolher}
      />,
    );

    const botoes = screen.getAllByRole("button");
    expect(botoes).toHaveLength(4);
    const textoDoTerceiro = textoDaAlternativa(botoes[2]);

    fireEvent.keyDown(window, { key: "3" });

    expect(onEscolher).toHaveBeenCalledTimes(1);
    expect(onEscolher).toHaveBeenCalledWith(textoDoTerceiro, textoDoTerceiro === "Paris");
  });

  it("não reage a teclas fora de 1-4, nem quando escolhida já não é null", () => {
    const onEscolher = vi.fn();
    const { rerender } = render(
      <MultiplaEscolha
        correta="Paris"
        erradas={["Lyon", "Nice", "Marselha"]}
        cartaoId="carta-1"
        escolhida={null}
        onEscolher={onEscolher}
      />,
    );

    fireEvent.keyDown(window, { key: "9" });
    expect(onEscolher).not.toHaveBeenCalled();

    rerender(
      <MultiplaEscolha
        correta="Paris"
        erradas={["Lyon", "Nice", "Marselha"]}
        cartaoId="carta-1"
        escolhida="Paris"
        onEscolher={onEscolher}
      />,
    );
    fireEvent.keyDown(window, { key: "1" });
    expect(onEscolher).not.toHaveBeenCalled();
  });

  it("não captura a tecla quando o foco está num campo de texto", () => {
    const onEscolher = vi.fn();
    render(
      <div>
        <input aria-label="campo-externo" />
        <MultiplaEscolha
          correta="Paris"
          erradas={["Lyon", "Nice", "Marselha"]}
          cartaoId="carta-1"
          escolhida={null}
          onEscolher={onEscolher}
        />
      </div>,
    );

    const campo = screen.getByLabelText("campo-externo");
    campo.focus();
    fireEvent.keyDown(campo, { key: "1" });

    expect(onEscolher).not.toHaveBeenCalled();
  });

  it("não captura a tecla quando o alvo é contentEditable (editor TipTap)", () => {
    const onEscolher = vi.fn();
    render(
      <div>
        <div aria-label="bloco-editavel" contentEditable suppressContentEditableWarning />
        <MultiplaEscolha
          correta="Paris"
          erradas={["Lyon", "Nice", "Marselha"]}
          cartaoId="carta-1"
          escolhida={null}
          onEscolher={onEscolher}
        />
      </div>,
    );

    const bloco = screen.getByLabelText("bloco-editavel");
    // jsdom não implementa `isContentEditable` (propriedade nem existe no
    // protótipo — confirmado: `"isContentEditable" in el` é `false`), embora
    // implemente o atributo `contenteditable` normalmente. Num browser real
    // (o WebView do Tauri) o getter funciona; aqui simulamos o valor que ele
    // devolveria para exercitar o mesmo guard que o componente usa.
    Object.defineProperty(bloco, "isContentEditable", { value: true, configurable: true });
    bloco.focus();
    fireEvent.keyDown(bloco, { key: "1" });

    expect(onEscolher).not.toHaveBeenCalled();
  });
});
