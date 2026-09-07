import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  answerCard,
  deckCounts,
  listNoteTypes,
  nextCard,
  type CardRow,
  type CardToStudy,
  type NoteRow,
  type NoteTypeRow,
  type PageRow,
} from "../../lib/ipc";
import { usePageTreeStore } from "../pages/store";
import { EstudoSessao } from "./EstudoSessao";
import { lembrarPaginaDoBloco } from "./origem-do-cartao";
import { useCartoesStore } from "./store";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    nextCard: vi.fn(),
    answerCard: vi.fn(),
    listNoteTypes: vi.fn(),
    deckCounts: vi.fn(),
  };
});

const nextCardMock = vi.mocked(nextCard);
const answerCardMock = vi.mocked(answerCard);
const deckCountsMock = vi.mocked(deckCounts);
const listNoteTypesMock = vi.mocked(listNoteTypes);

function cardRow(overrides: Partial<CardRow> = {}): CardRow {
  return {
    id: "card-1",
    noteId: "note-1",
    deckId: "deck-1",
    templateOrdinal: 0,
    state: "review",
    due: "2026-01-01T00:00:00Z",
    scheduler: "sm2",
    intervalDays: 10,
    easeFactor: 2500,
    fsrsStability: null,
    fsrsDifficulty: null,
    fsrsLastReviewAt: null,
    learningStep: 0,
    lapses: 0,
    reps: 3,
    isLeech: false,
    flags: 0,
    suspendedAt: null,
    buriedUntil: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    id: "note-1",
    noteTypeId: "tipo-1",
    deckId: "deck-1",
    fieldValues: { Frente: "Qual a capital da França?", Verso: "Paris" },
    tags: [],
    sourceBlockId: null,
    sourceTextFrozen: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function cardToStudy(overrides: Partial<CardToStudy> = {}): CardToStudy {
  const note = overrides.note ?? noteRow();
  return {
    card: cardRow(),
    note,
    fields: note.fieldValues,
    // A fixture precisa carregar `fieldNames` porque o backend carrega: foi
    // exatamente uma fixture fabricada no formato errado que escondeu, durante
    // toda a construção da seção, o `fields` que viajava como lista.
    fieldNames: Object.keys(note.fieldValues),
    deckName: "Geografia",
    ...overrides,
  };
}

const TIPO_BASICO: NoteTypeRow = {
  id: "tipo-1",
  name: "Básico",
  fields: ["Frente", "Verso"],
  templates: [{ name: "Cartão 1", front: "{{Frente}}", back: "{{Verso}}" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const TIPO_DIGITAR_RESPOSTA: NoteTypeRow = {
  id: "tipo-2",
  name: "Digitar a resposta",
  fields: ["Frente", "Verso"],
  templates: [{ name: "Cartão 1", front: "{{Frente}}", back: "{{type:Verso}}" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const TIPO_MULTIPLA_ESCOLHA: NoteTypeRow = {
  id: "tipo-3",
  name: "Múltipla escolha",
  fields: ["Pergunta", "Correta", "Errada 1", "Errada 2", "Errada 3"],
  templates: [{ name: "Cartão 1", front: "{{Pergunta}}", back: "{{Correta}}" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function pageRow(overrides: Partial<PageRow> & Pick<PageRow, "id">): PageRow {
  return {
    parent_id: null,
    database_id: null,
    title: "",
    icon: null,
    position: "1",
    is_favorite: false,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  usePageTreeStore.setState({ pagesById: new Map() });
  deckCountsMock.mockResolvedValue({ novos: 0, aprendendo: 0, revisar: 0 });
  useCartoesStore.setState({
    deckSelecionadoId: null,
    decksById: new Map(),
    noteTypes: [TIPO_BASICO],
    noteTypesStatus: "ready",
    tela: "estudo",
    contagens: new Map(),
  });
});

describe("EstudoSessao", () => {
  it("mostra a frente sem o verso — o verso não existe no DOM antes de revelar", async () => {
    nextCardMock.mockResolvedValue(cardToStudy());

    render(<EstudoSessao />);

    expect(await screen.findByText("Qual a capital da França?")).toBeInTheDocument();
    // Não é "escondido por CSS": o texto literalmente não está no documento.
    expect(screen.queryByText("Paris")).not.toBeInTheDocument();
  });

  it("clicar em 'Mostrar resposta' revela o verso e os quatro botões de resposta", async () => {
    nextCardMock.mockResolvedValue(cardToStudy());
    render(<EstudoSessao />);
    await screen.findByText("Qual a capital da França?");

    fireEvent.click(screen.getByRole("button", { name: /Mostrar resposta/ }));

    expect(screen.getByText("Paris")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Errei/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Difícil/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bom/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fácil/ })).toBeInTheDocument();
  });

  it("REQUISITO CRÍTICO: clique duplo em 'Bom' chama answerCard só uma vez", async () => {
    nextCardMock.mockResolvedValue(cardToStudy());
    // A resposta de `answerCard` fica pendente até o teste liberar — é a
    // janela em que um segundo clique, se não fosse bloqueado, dispararia
    // uma segunda chamada.
    let liberarResposta: (() => void) | undefined;
    answerCardMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          liberarResposta = () => resolve({ proximaRevisao: "2026-09-08T12:00:00.000Z", intervaloDias: 3, estado: "review" });
        }),
    );

    render(<EstudoSessao />);
    await screen.findByText("Qual a capital da França?");
    fireEvent.click(screen.getByRole("button", { name: /Mostrar resposta/ }));

    const botaoBom = screen.getByRole("button", { name: /Bom/ });
    // Dois cliques síncronos, sem esperar nada entre eles — exatamente o
    // duplo clique que não pode agendar duas vezes.
    fireEvent.click(botaoBom);
    fireEvent.click(botaoBom);

    expect(answerCardMock).toHaveBeenCalledTimes(1);

    liberarResposta?.();
    await waitFor(() => expect(nextCardMock).toHaveBeenCalledTimes(2));
    // Esperar a SEGUNDA carga terminar de desenhar, não só ser chamada.
    // `answerCard` ficou pendente de propósito neste teste, e liberá-la
    // dispara uma cadeia (`refreshAllCounts` grava na store do zustand, que é
    // global; depois `carregarProximo` monta o cartão seguinte). Terminar o
    // teste no meio dessa cadeia deixava as escritas caindo DEPOIS do
    // `beforeEach` do teste seguinte — que acabara de plantar o estado dele.
    // É trabalho em voo cruzando a fronteira entre dois testes, e era a fonte
    // de uma falha intermitente (~1 em 10) no teste da tecla "3".
    await screen.findByText("Qual a capital da França?");
  });

  it("tecla '3' responde 'Bom' só depois de revelado — antes disso não faz nada", async () => {
    nextCardMock.mockResolvedValue(cardToStudy());
    answerCardMock.mockResolvedValue({ proximaRevisao: "2026-09-08T12:00:00.000Z", intervaloDias: 3, estado: "review" });
    render(<EstudoSessao />);
    await screen.findByText("Qual a capital da França?");

    fireEvent.keyDown(window, { key: "3" });
    expect(answerCardMock).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByText("Paris")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "3" });
    await waitFor(() => expect(answerCardMock).toHaveBeenCalledWith("card-1", "good"));
  });

  it("fila vazia (nextCard devolve null) mostra o estado 'nada para estudar', não uma tela quebrada", async () => {
    nextCardMock.mockResolvedValue(null);

    render(<EstudoSessao />);

    expect(await screen.findByText("Nada para estudar agora")).toBeInTheDocument();
  });

  it("erro ao carregar o próximo cartão mostra alerta em vez de travar", async () => {
    nextCardMock.mockRejectedValue(new Error("sem conexão"));

    render(<EstudoSessao />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar o próximo cartão.");
  });

  it("com os tipos de nota ainda carregando, o cartão não é desenhado — nem a frente", async () => {
    // `loadNoteTypes` e `nextCard` disparam em efeitos independentes, sem
    // ordem garantida: existe uma janela real em que o cartão já chegou e a
    // lista de tipos não. Antes desta trava, a tela desenhava o cartão como
    // "Básico" nessa janela — o que, num cartão de múltipla escolha, punha as
    // três alternativas ERRADAS no verso como se fossem a resposta (o teste
    // seguinte é a prova disso). Sem saber o tipo, não há resposta certa sobre
    // o que pode aparecer, então a tela espera.
    useCartoesStore.setState({ noteTypes: [], noteTypesStatus: "loading" });
    nextCardMock.mockResolvedValue(cardToStudy());

    render(<EstudoSessao />);

    expect(await screen.findByText("Carregando…")).toBeInTheDocument();
    expect(screen.queryByText("Qual a capital da França?")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mostrar resposta/ })).not.toBeInTheDocument();
  });

  it("na janela de corrida, um cartão de 'Múltipla escolha' não vaza nenhuma alternativa errada", async () => {
    useCartoesStore.setState({ noteTypes: [], noteTypesStatus: "loading" });
    nextCardMock.mockResolvedValue(
      cardToStudy({
        note: noteRow({
          noteTypeId: "tipo-3",
          fieldValues: {
            Pergunta: "Capital da França?",
            Correta: "Paris",
            "Errada 1": "Londres",
            "Errada 2": "Roma",
            "Errada 3": "Berlim",
          },
        }),
      }),
    );

    render(<EstudoSessao />);
    await screen.findByText("Carregando…");

    // O espaço também não pode marcar `revelado` durante a espera: o efeito de
    // teclado roda mesmo com a tela mostrando "Carregando…", e sem a guarda a
    // resposta apareceria já revelada assim que os tipos chegassem.
    fireEvent.keyDown(window, { key: " " });

    for (const errada of ["Londres", "Roma", "Berlim"]) {
      expect(screen.queryByText(errada)).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Paris")).not.toBeInTheDocument();
  });

  it("falha ao carregar os tipos de nota para a sessão em vez de estudar como 'Básico'", async () => {
    // Cair para "Básico" quando os tipos falham entregaria as alternativas
    // erradas junto com a certa. Parar e dizer o motivo é o desfecho seguro.
    //
    // O estado "error" precisa vir de uma falha DE VERDADE, não de um
    // `setState`: a store retenta quando o status não é "loading" nem "ready"
    // (`store.ts:109`), então plantar "error" à mão seria desfeito pelo efeito
    // de montagem e o teste passaria a medir outra coisa.
    useCartoesStore.setState({ noteTypes: [], noteTypesStatus: "idle" });
    listNoteTypesMock.mockRejectedValue(new Error("banco fora do ar"));
    nextCardMock.mockResolvedValue(cardToStudy());

    render(<EstudoSessao />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/tipos de nota/);
    expect(screen.queryByText("Qual a capital da França?")).not.toBeInTheDocument();
  });

  it("tipo de nota desconhecido (importado de um .apkg) cai no comportamento antigo, sem quebrar", async () => {
    // Diferente da janela de corrida acima: aqui os tipos JÁ carregaram e o
    // tipo do cartão simplesmente não é nenhum dos três que o app semeia.
    // Frente e verso por posição é o comportamento seguro para um tipo que
    // ninguém aqui conhece.
    useCartoesStore.setState({ noteTypes: [TIPO_BASICO], noteTypesStatus: "ready" });
    nextCardMock.mockResolvedValue(cardToStudy({ note: noteRow({ noteTypeId: "tipo-vindo-do-anki" }) }));

    render(<EstudoSessao />);

    expect(await screen.findByText("Qual a capital da França?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Mostrar resposta/ }));
    expect(screen.getByText("Paris")).toBeInTheDocument();
  });

  it("mostra a procedência 'de: <página>' quando o cartão tem bloco de origem conhecido", async () => {
    usePageTreeStore.setState({
      pagesById: new Map([["pagina-1", pageRow({ id: "pagina-1", title: "Biologia celular" })]]),
    });
    lembrarPaginaDoBloco("bloco-1", "pagina-1");
    nextCardMock.mockResolvedValue(
      cardToStudy({ note: noteRow({ sourceBlockId: "bloco-1", sourceTextFrozen: "A mitocôndria é..." }) }),
    );

    render(<EstudoSessao />);

    expect(await screen.findByRole("button", { name: "de: Biologia celular" })).toBeInTheDocument();
  });

  it("mostra só o texto congelado, sem link, quando o bloco de origem foi apagado (INT-009)", async () => {
    nextCardMock.mockResolvedValue(
      cardToStudy({ note: noteRow({ sourceBlockId: null, sourceTextFrozen: "A mitocôndria é a organela..." }) }),
    );

    render(<EstudoSessao />);

    expect(await screen.findByText("de: “A mitocôndria é a organela...”")).toBeInTheDocument();
  });

  it("campo da frente vazio (nota sem conteúdo digitado) mostra o texto de reserva em vez de uma linha em branco", async () => {
    nextCardMock.mockResolvedValue(
      cardToStudy({ note: noteRow({ fieldValues: { Frente: "", Verso: "" } }), fields: { Frente: "", Verso: "" } }),
    );

    render(<EstudoSessao />);

    expect(await screen.findByText("(sem conteúdo)")).toBeInTheDocument();
  });

  it("'Digitar a resposta' mostra o campo de digitação, não o botão 'Mostrar resposta'", async () => {
    useCartoesStore.setState({ noteTypes: [TIPO_BASICO, TIPO_DIGITAR_RESPOSTA] });
    nextCardMock.mockResolvedValue(
      cardToStudy({
        note: noteRow({ noteTypeId: "tipo-2", fieldValues: { Frente: "Capital da França?", Verso: "Paris" } }),
      }),
    );

    render(<EstudoSessao />);

    expect(await screen.findByText("Capital da França?")).toBeInTheDocument();
    expect(screen.getByLabelText("Sua resposta")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mostrar resposta/ })).not.toBeInTheDocument();
  });

  it("'Digitar a resposta': acertar revela o verso e os botões de nota", async () => {
    useCartoesStore.setState({ noteTypes: [TIPO_BASICO, TIPO_DIGITAR_RESPOSTA] });
    nextCardMock.mockResolvedValue(
      cardToStudy({
        note: noteRow({ noteTypeId: "tipo-2", fieldValues: { Frente: "Capital da França?", Verso: "Paris" } }),
      }),
    );

    render(<EstudoSessao />);
    await screen.findByText("Capital da França?");

    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "Paris" } });
    fireEvent.click(screen.getByRole("button", { name: "Conferir" }));

    expect(screen.getByText("Resposta: Paris")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bom/ })).toBeInTheDocument();
  });

  it("'Digitar a resposta': errar também revela — errar também é estudar", async () => {
    useCartoesStore.setState({ noteTypes: [TIPO_BASICO, TIPO_DIGITAR_RESPOSTA] });
    nextCardMock.mockResolvedValue(
      cardToStudy({
        note: noteRow({ noteTypeId: "tipo-2", fieldValues: { Frente: "Capital da França?", Verso: "Paris" } }),
      }),
    );

    render(<EstudoSessao />);
    await screen.findByText("Capital da França?");

    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "Londres" } });
    fireEvent.click(screen.getByRole("button", { name: "Conferir" }));

    expect(screen.getByText("Resposta: Paris")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bom/ })).toBeInTheDocument();
  });

  it("espaço NÃO revela 'Digitar a resposta' (revelar sem digitar furaria o exercício)", async () => {
    useCartoesStore.setState({ noteTypes: [TIPO_BASICO, TIPO_DIGITAR_RESPOSTA] });
    nextCardMock.mockResolvedValue(
      cardToStudy({
        note: noteRow({ noteTypeId: "tipo-2", fieldValues: { Frente: "Capital da França?", Verso: "Paris" } }),
      }),
    );

    render(<EstudoSessao />);
    await screen.findByText("Capital da França?");

    fireEvent.keyDown(window, { key: " " });

    expect(screen.queryByText("Resposta: Paris")).not.toBeInTheDocument();
  });

  it("'Múltipla escolha' mostra as alternativas e, ao escolher, o verso mostra só a Correta", async () => {
    useCartoesStore.setState({ noteTypes: [TIPO_BASICO, TIPO_MULTIPLA_ESCOLHA] });
    nextCardMock.mockResolvedValue(
      cardToStudy({
        note: noteRow({
          noteTypeId: "tipo-3",
          fieldValues: {
            Pergunta: "Capital da França?",
            Correta: "Paris",
            "Errada 1": "Londres",
            "Errada 2": "Roma",
            "Errada 3": "Berlim",
          },
        }),
      }),
    );

    render(<EstudoSessao />);
    await screen.findByText("Capital da França?");

    expect(screen.getByText("Londres")).toBeInTheDocument();
    expect(screen.getByText("Roma")).toBeInTheDocument();
    expect(screen.getByText("Berlim")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Paris"));

    // O verso do cartão (bloco revelado) mostra só a Correta — as erradas
    // continuam visíveis só dentro dos botões de `MultiplaEscolha`, nunca
    // como se fossem parte da resposta.
    expect(screen.getByRole("button", { name: /Bom/ })).toBeInTheDocument();
    expect(screen.queryByText("Errada 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Errada 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Errada 3")).not.toBeInTheDocument();
  });

  it("espaço NÃO revela 'Múltipla escolha' (revelar sem escolher furaria o exercício)", async () => {
    useCartoesStore.setState({ noteTypes: [TIPO_BASICO, TIPO_MULTIPLA_ESCOLHA] });
    nextCardMock.mockResolvedValue(
      cardToStudy({
        note: noteRow({
          noteTypeId: "tipo-3",
          fieldValues: {
            Pergunta: "Capital da França?",
            Correta: "Paris",
            "Errada 1": "Londres",
            "Errada 2": "Roma",
            "Errada 3": "Berlim",
          },
        }),
      }),
    );

    render(<EstudoSessao />);
    await screen.findByText("Capital da França?");

    fireEvent.keyDown(window, { key: " " });

    expect(screen.queryByRole("button", { name: /Bom/ })).not.toBeInTheDocument();
  });

  it("espaço continua revelando o Básico normalmente (comportamento antigo intacto)", async () => {
    nextCardMock.mockResolvedValue(cardToStudy());
    render(<EstudoSessao />);
    await screen.findByText("Qual a capital da França?");

    fireEvent.keyDown(window, { key: " " });

    expect(screen.getByText("Paris")).toBeInTheDocument();
  });
});
