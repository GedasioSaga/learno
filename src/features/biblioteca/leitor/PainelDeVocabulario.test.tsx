import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { criarNotaComOrigem } from "../../cartoes/criar-nota-com-origem";
import { useCartoesStore } from "../../cartoes/store";
import { buildChildrenIndex } from "../../cartoes/tree-utils";
import {
  AppError,
  atualizarPalavra,
  coletarPalavra,
  definirMarcacaoDaPalavra,
  removerPalavra,
  type DeckRow,
  type NoteRow,
  type NoteTypeRow,
  type PalavraColetada,
} from "../../../lib/ipc";
import { PainelDeVocabulario, type SelecaoParaColeta } from "./PainelDeVocabulario";

vi.mock("../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/ipc")>();
  return {
    ...actual,
    coletarPalavra: vi.fn(),
    atualizarPalavra: vi.fn(),
    definirMarcacaoDaPalavra: vi.fn(),
    removerPalavra: vi.fn(),
  };
});

vi.mock("../../cartoes/criar-nota-com-origem", () => ({
  criarNotaComOrigem: vi.fn(),
}));

const coletarPalavraMock = vi.mocked(coletarPalavra);
const atualizarPalavraMock = vi.mocked(atualizarPalavra);
const definirMarcacaoDaPalavraMock = vi.mocked(definirMarcacaoDaPalavra);
const removerPalavraMock = vi.mocked(removerPalavra);
const criarNotaComOrigemMock = vi.mocked(criarNotaComOrigem);

/** Mesmo baralho/tipo de nota mínimo usado por `LeitorDeLivro.test.tsx` — o formulário de cartão exige os dois para não cair no aviso "crie um baralho". */
function deckFixture(overrides: Partial<DeckRow> & Pick<DeckRow, "id">): DeckRow {
  return {
    parentId: null,
    name: "",
    options: null,
    position: "1",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const TIPO_BASICO: NoteTypeRow = {
  id: "tipo-1",
  name: "Básico",
  fields: ["Frente", "Verso"],
  templates: [{ name: "Cartão 1", front: "{{Frente}}", back: "{{Verso}}" }],
  kind: "standard",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function noteRowFixture(): NoteRow {
  return {
    id: "nota-1",
    noteTypeId: "tipo-1",
    deckId: "ingles",
    fieldValues: { Frente: "a mitocôndria é a usina da célula", Verso: "Verso do cartão" },
    tags: [],
    sourceBlockId: null,
    sourceTextFrozen: "a mitocôndria é a usina da célula",
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function palavraFixture(overrides: Partial<PalavraColetada> = {}): PalavraColetada {
  return {
    id: "palavra-1",
    bookId: "livro-1",
    term: "mitocôndria",
    contextSnippet: "a mitocôndria é a usina da célula",
    note: null,
    synonyms: [],
    antonyms: [],
    highlightInBook: true,
    locator: "42",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const SELECAO_FIXTURE: SelecaoParaColeta = {
  texto: "mitocôndria",
  contexto: "a mitocôndria é a usina da célula",
  locator: "42",
};

/**
 * A lista mora na casca (`LeitorDeLivro`) agora; este dublê faz o papel dela
 * com um `useState` de verdade, para o teste ver a lista mudar depois de cada
 * ação do painel — inclusive a volta do marcador quando o IPC falha.
 */
function PainelComLista({
  inicial = [],
  selecao = null,
  carregando = false,
  erro = null,
}: {
  inicial?: PalavraColetada[];
  selecao?: SelecaoParaColeta | null;
  carregando?: boolean;
  erro?: string | null;
}) {
  const [palavras, setPalavras] = useState(inicial);
  return (
    <PainelDeVocabulario
      livroId="livro-1"
      selecao={selecao}
      palavras={palavras}
      carregando={carregando}
      erro={erro}
      onMudarPalavras={setPalavras}
    />
  );
}

/** Um `Promise` que o teste resolve ou rejeita na hora que quiser — para enxergar o estado otimista ANTES da resposta do IPC. */
function promessaControlada<T>() {
  let resolver: (valor: T) => void = () => {};
  let rejeitar: (erro: unknown) => void = () => {};
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

beforeEach(() => {
  vi.clearAllMocks();
  const ingles = deckFixture({ id: "ingles", name: "Inglês" });
  useCartoesStore.setState({
    decksById: new Map([["ingles", ingles]]),
    childrenIndex: buildChildrenIndex([ingles]),
    deckSelecionadoId: "ingles",
    noteTypes: [TIPO_BASICO],
    noteTypesStatus: "ready",
  });
});

describe("sem seleção — a lista do que já foi colhido", () => {
  it("lista vazia diz o que fazer em vez de ficar em branco", () => {
    render(<PainelComLista />);

    expect(screen.getByText(/Nenhuma palavra colhida ainda\. Selecione uma palavra durante a leitura/)).toBeInTheDocument();
  });

  it("carregando e erro de carregamento vêm da casca", () => {
    const { rerender } = render(<PainelComLista carregando />);
    expect(screen.getByText("Carregando palavras…")).toBeInTheDocument();

    rerender(<PainelComLista erro="Não foi possível carregar as palavras colhidas." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível carregar as palavras colhidas.");
  });

  it("a busca filtra de verdade, por termo, por significado ou por sinônimo", () => {
    render(
      <PainelComLista
        inicial={[
          palavraFixture({ id: "a", term: "mitocôndria" }),
          palavraFixture({
            id: "b",
            term: "ribossomo",
            contextSnippet: "o ribossomo fica no citoplasma",
            note: "organela que sintetiza proteína",
            synonyms: ["grânulo de Palade"],
          }),
        ]}
      />,
    );
    expect(screen.getByText("mitocôndria")).toBeInTheDocument();
    expect(screen.getByText("ribossomo")).toBeInTheDocument();

    const busca = screen.getByRole("textbox", { name: "Buscar palavra colhida" });
    fireEvent.change(busca, { target: { value: "mito" } });
    expect(screen.getByText("mitocôndria")).toBeInTheDocument();
    expect(screen.queryByText("ribossomo")).not.toBeInTheDocument();

    fireEvent.change(busca, { target: { value: "sintetiza" } });
    expect(screen.getByText("ribossomo")).toBeInTheDocument();
    expect(screen.queryByText("mitocôndria")).not.toBeInTheDocument();

    fireEvent.change(busca, { target: { value: "palade" } });
    expect(screen.getByText("ribossomo")).toBeInTheDocument();
    expect(screen.queryByText("mitocôndria")).not.toBeInTheDocument();
  });

  it("busca sem nenhuma correspondência mostra uma mensagem específica, não a lista vazia genérica", () => {
    render(<PainelComLista inicial={[palavraFixture()]} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Buscar palavra colhida" }), { target: { value: "zzz" } });

    expect(screen.getByText("Nenhuma palavra encontrada para “zzz”.")).toBeInTheDocument();
  });
});

describe("o card — clicar abre o significado inteiro, os sinônimos e os antônimos", () => {
  const SIGNIFICADO_LONGO =
    "que come com avidez, de forma insaciável; por extensão, quem deseja algo com intensidade, sem medida nem pausa";

  it("clicar no card mostra o significado inteiro e as etiquetas; clicar de novo fecha", () => {
    render(
      <PainelComLista
        inicial={[palavraFixture({ term: "voraz", note: SIGNIFICADO_LONGO, synonyms: ["ávido", "faminto"], antonyms: ["saciado"] })]}
      />,
    );
    const abrir = screen.getByRole("button", { name: "voraz" });
    const significado = screen.getByText(SIGNIFICADO_LONGO);

    // Fechado: o começo do significado (duas linhas) e nenhuma etiqueta ao alcance.
    expect(abrir).toHaveAttribute("aria-expanded", "false");
    expect(significado).toHaveClass("line-clamp-2");
    expect(screen.queryByRole("list", { name: "Sinônimos de voraz" })).not.toBeInTheDocument();

    fireEvent.click(abrir);

    expect(abrir).toHaveAttribute("aria-expanded", "true");
    expect(significado).not.toHaveClass("line-clamp-2");
    const sinonimos = screen.getByRole("list", { name: "Sinônimos de voraz" });
    expect(within(sinonimos).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["ávido", "faminto"]);
    const antonimos = screen.getByRole("list", { name: "Antônimos de voraz" });
    expect(within(antonimos).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["saciado"]);

    fireEvent.click(abrir);

    expect(abrir).toHaveAttribute("aria-expanded", "false");
    expect(significado).toHaveClass("line-clamp-2");
    expect(screen.queryByRole("list", { name: "Sinônimos de voraz" })).not.toBeInTheDocument();
  });

  it("seção vazia some; sem nada preenchido, aberto mostra a dica do lápis", () => {
    render(
      <PainelComLista
        inicial={[
          palavraFixture({ id: "a", term: "voraz", note: "que come muito", synonyms: ["ávido"], antonyms: [] }),
          // Todo campo opcional ausente: sem contexto, sem locator, sem significado, listas vazias.
          palavraFixture({ id: "b", term: "austera", contextSnippet: null, locator: null, note: null, synonyms: [], antonyms: [] }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "voraz" }));
    expect(screen.getByRole("list", { name: "Sinônimos de voraz" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Antônimos de voraz" })).not.toBeInTheDocument();
    expect(screen.queryByText("Antônimos")).not.toBeInTheDocument();

    // Fechada, a região continua no DOM (é o que deixa a transição de fechar
    // existir), mas fora do alcance: `aria-hidden` e `inert`.
    const dica = screen.getByText("Use o lápis para adicionar significado, sinônimos e antônimos.");
    expect(dica.closest("[aria-hidden='true']")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "austera" }));
    expect(dica.closest("[aria-hidden='true']")).toBeNull();
    expect(dica.closest("[inert]")).toBeNull();
  });

  it("a linha do contexto some quando só repete a palavra (ignorando caixa e acento), e aparece quando acrescenta", () => {
    render(
      <PainelComLista
        inicial={[
          palavraFixture({ id: "a", term: "éban", contextSnippet: "Eban" }),
          palavraFixture({ id: "b", term: "voraz", contextSnippet: "o lobo voraz atravessou a ponte" }),
        ]}
      />,
    );

    expect(screen.queryByText("“Eban”")).not.toBeInTheDocument();
    expect(screen.getByText("“o lobo voraz atravessou a ponte”")).toBeInTheDocument();
  });

  it("o lápis edita os três campos e salva com atualizarPalavra(id, significado, sinônimos, antônimos)", async () => {
    render(<PainelComLista inicial={[palavraFixture({ term: "voraz", note: "come muito" })]} />);
    atualizarPalavraMock.mockResolvedValue(
      palavraFixture({ term: "voraz", note: "que come com avidez", synonyms: ["ávido", "faminto"], antonyms: ["saciado"] }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Editar voraz" }));
    expect(screen.getByLabelText("Significado")).toHaveValue("come muito");
    fireEvent.change(screen.getByLabelText("Significado"), { target: { value: "  que come com avidez " } });
    fireEvent.change(screen.getByLabelText("Sinônimos"), { target: { value: " ávido , ,faminto" } });
    fireEvent.change(screen.getByLabelText("Antônimos"), { target: { value: "saciado" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(atualizarPalavraMock).toHaveBeenCalledWith("palavra-1", "que come com avidez", ["ávido", "faminto"], ["saciado"]),
    );
    expect(await screen.findByText("que come com avidez")).toBeInTheDocument();
    expect(screen.queryByLabelText("Significado")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "voraz" }));
    expect(within(screen.getByRole("list", { name: "Sinônimos de voraz" })).getByText("faminto")).toBeInTheDocument();
  });

  it("o lápis abre com os campos já preenchidos, listas separadas por vírgula; Esc cancela sem salvar", () => {
    render(<PainelComLista inicial={[palavraFixture({ term: "voraz", synonyms: ["ávido", "faminto"], antonyms: ["saciado"] })]} />);

    fireEvent.click(screen.getByRole("button", { name: "Editar voraz" }));
    expect(screen.getByLabelText("Sinônimos")).toHaveValue("ávido, faminto");
    expect(screen.getByLabelText("Antônimos")).toHaveValue("saciado");

    fireEvent.keyDown(screen.getByLabelText("Sinônimos"), { key: "Escape" });

    expect(screen.queryByLabelText("Sinônimos")).not.toBeInTheDocument();
    expect(atualizarPalavraMock).not.toHaveBeenCalled();
  });

  it("erro ao salvar aparece por cima da lista, sem escondê-la", async () => {
    render(<PainelComLista inicial={[palavraFixture({ term: "voraz" })]} />);
    atualizarPalavraMock.mockRejectedValue(new Error("banco ocupado"));

    fireEvent.click(screen.getByRole("button", { name: "Editar voraz" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar a palavra.");
    expect(screen.getByRole("button", { name: "voraz" })).toBeInTheDocument();
  });
});

describe("o marcador — sublinhar a palavra no livro", () => {
  it("desliga na hora (otimista) e chama definirMarcacaoDaPalavra(id, false)", async () => {
    render(<PainelComLista inicial={[palavraFixture({ term: "voraz", highlightInBook: true })]} />);
    const resposta = promessaControlada<PalavraColetada>();
    definirMarcacaoDaPalavraMock.mockReturnValue(resposta.promessa);
    const marcador = screen.getByRole("button", { name: "Marcar voraz no livro" });
    expect(marcador).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(marcador);

    expect(definirMarcacaoDaPalavraMock).toHaveBeenCalledWith("palavra-1", false);
    expect(marcador).toHaveAttribute("aria-pressed", "false");

    await act(async () => resposta.resolver(palavraFixture({ term: "voraz", highlightInBook: false })));
    expect(marcador).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("IPC falhou: o marcador volta ao estado de antes e o erro aparece", async () => {
    render(<PainelComLista inicial={[palavraFixture({ term: "voraz", highlightInBook: true })]} />);
    const resposta = promessaControlada<PalavraColetada>();
    definirMarcacaoDaPalavraMock.mockReturnValue(resposta.promessa);
    const marcador = screen.getByRole("button", { name: "Marcar voraz no livro" });

    fireEvent.click(marcador);
    expect(marcador).toHaveAttribute("aria-pressed", "false");

    await act(async () => resposta.rejeitar(new Error("banco ocupado")));

    expect(marcador).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível desligar o marcador de “voraz”.");
  });

  it("palavra desligada liga com definirMarcacaoDaPalavra(id, true)", async () => {
    render(<PainelComLista inicial={[palavraFixture({ term: "voraz", highlightInBook: false })]} />);
    definirMarcacaoDaPalavraMock.mockResolvedValue(palavraFixture({ term: "voraz", highlightInBook: true }));
    const marcador = screen.getByRole("button", { name: "Marcar voraz no livro" });
    expect(marcador).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(marcador);

    await waitFor(() => expect(definirMarcacaoDaPalavraMock).toHaveBeenCalledWith("palavra-1", true));
    expect(marcador).toHaveAttribute("aria-pressed", "true");
  });

  it("o clique no marcador não abre nem fecha o card", () => {
    render(<PainelComLista inicial={[palavraFixture({ term: "voraz" })]} />);
    definirMarcacaoDaPalavraMock.mockReturnValue(promessaControlada<PalavraColetada>().promessa);

    fireEvent.click(screen.getByRole("button", { name: "Marcar voraz no livro" }));

    expect(screen.getByRole("button", { name: "voraz" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("remover e cartão", () => {
  it("remover exige confirmação NO PRÓPRIO PAINEL antes de chamar removerPalavra", async () => {
    render(<PainelComLista inicial={[palavraFixture()]} />);
    removerPalavraMock.mockResolvedValue(undefined);

    fireEvent.click(screen.getByRole("button", { name: "Remover mitocôndria" }));
    expect(removerPalavraMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remover mesmo assim" }));

    await waitFor(() => expect(removerPalavraMock).toHaveBeenCalledWith("palavra-1"));
    await waitFor(() => expect(screen.queryByText("mitocôndria")).not.toBeInTheDocument());
  });

  it("cancelar a confirmação de remoção não chama removerPalavra", () => {
    render(<PainelComLista inicial={[palavraFixture()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Remover mitocôndria" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(removerPalavraMock).not.toHaveBeenCalled();
    expect(screen.getByText("mitocôndria")).toBeInTheDocument();
  });

  it("a ponte com cartões: 'Cartão' abre o formulário compartilhado com a frase de origem já na frente", async () => {
    render(<PainelComLista inicial={[palavraFixture()]} />);
    criarNotaComOrigemMock.mockResolvedValue(noteRowFixture());

    fireEvent.click(screen.getByRole("button", { name: "Cartão" }));

    expect(await screen.findByLabelText("Frente")).toHaveValue("a mitocôndria é a usina da célula");
  });
});

describe("com seleção ativa — colher a palavra", () => {
  it("colhe com termo, contexto, significado, sinônimos, antônimos e locator — e a palavra entra na lista", async () => {
    const nova = palavraFixture({ note: "lembrar de revisar", synonyms: ["ávido", "faminto"], antonyms: ["saciado"] });
    coletarPalavraMock.mockResolvedValue(nova);
    const { rerender } = render(<PainelComLista selecao={SELECAO_FIXTURE} />);

    fireEvent.change(screen.getByLabelText("Significado (opcional)"), { target: { value: "lembrar de revisar" } });
    fireEvent.change(screen.getByLabelText("Sinônimos (opcional)"), { target: { value: "ávido, faminto" } });
    fireEvent.change(screen.getByLabelText("Antônimos (opcional)"), { target: { value: " saciado " } });
    fireEvent.click(screen.getByRole("button", { name: "Colher palavra" }));

    await waitFor(() =>
      expect(coletarPalavraMock).toHaveBeenCalledWith(
        "livro-1",
        "mitocôndria",
        "a mitocôndria é a usina da célula",
        "lembrar de revisar",
        ["ávido", "faminto"],
        ["saciado"],
        "42",
      ),
    );
    expect(await screen.findByText("Palavra colhida.")).toBeInTheDocument();

    // A seleção fecha: o mesmo painel (mesmo estado da casca) volta à lista, já com a palavra nova.
    rerender(<PainelComLista selecao={null} />);
    expect(screen.getByRole("button", { name: "mitocôndria" })).toBeInTheDocument();
  });

  it("todos os campos opcionais vazios: listas vazias e significado nulo, nunca string vazia", async () => {
    coletarPalavraMock.mockResolvedValue(palavraFixture());
    render(<PainelComLista selecao={{ texto: "voraz", contexto: "", locator: "" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Colher palavra" }));

    await waitFor(() => expect(coletarPalavraMock).toHaveBeenCalledWith("livro-1", "voraz", null, null, [], [], null));
  });

  it("contexto que só repete a palavra selecionada não aparece no formulário; contexto que acrescenta aparece", () => {
    const { rerender } = render(<PainelComLista selecao={{ texto: "éban", contexto: "éban", locator: "3" }} />);

    expect(screen.queryByText("“éban”")).not.toBeInTheDocument();

    rerender(<PainelComLista selecao={SELECAO_FIXTURE} />);

    expect(screen.getByText("“a mitocôndria é a usina da célula”")).toBeInTheDocument();
  });

  it("termo só com espaço não chega ao IPC — o painel avisa em vez de deixar colher", () => {
    render(<PainelComLista selecao={{ texto: "   ", contexto: "frase qualquer", locator: "1" }} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Selecione uma palavra para colher.");
    expect(screen.queryByRole("button", { name: "Colher palavra" })).not.toBeInTheDocument();
    expect(coletarPalavraMock).not.toHaveBeenCalled();
  });

  it("colher a mesma palavra duas vezes no mesmo livro: o gatilho de duplicata vira mensagem útil, nunca o erro cru do SQL", async () => {
    coletarPalavraMock.mockRejectedValue(
      new AppError({
        kind: "database",
        message: "banco de dados: library_vocabulary.term duplicado neste livro (ignorando caixa e acento)",
      }),
    );

    render(<PainelComLista selecao={SELECAO_FIXTURE} />);
    fireEvent.click(screen.getByRole("button", { name: "Colher palavra" }));

    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("Essa palavra já foi colhida neste livro.");
    expect(alerta).not.toHaveTextContent("library_vocabulary");
    expect(alerta).not.toHaveTextContent("gatilho");
  });

  it("erro do IPC (não-duplicata) vira mensagem visível sem perder o que já foi digitado", async () => {
    coletarPalavraMock.mockRejectedValue(new Error("banco ocupado"));

    render(<PainelComLista selecao={SELECAO_FIXTURE} />);

    fireEvent.change(screen.getByLabelText("Significado (opcional)"), { target: { value: "não perder isto" } });
    fireEvent.change(screen.getByLabelText("Sinônimos (opcional)"), { target: { value: "ávido" } });
    fireEvent.click(screen.getByRole("button", { name: "Colher palavra" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível colher esta palavra.");
    expect(screen.getByLabelText("Significado (opcional)")).toHaveValue("não perder isto");
    expect(screen.getByLabelText("Sinônimos (opcional)")).toHaveValue("ávido");
  });
});
