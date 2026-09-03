import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setPageIcon } from "../../lib/ipc";
import { usePageTreeStore } from "./store";
import { EmojiIconPicker } from "./EmojiIconPicker";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return { ...actual, setPageIcon: vi.fn() };
});

const setPageIconMock = vi.mocked(setPageIcon);

beforeEach(() => {
  vi.clearAllMocks();
  usePageTreeStore.setState({
    status: "idle",
    errorMessage: null,
    pagesById: new Map(),
    childrenIndex: new Map(),
    expandedIds: new Set(),
    selectedPageId: null,
  });
});

// O painel é `popover="auto"`: fica `display: none` no jsdom (ver o comentário
// em `PageTree.test.tsx`), então toda consulta aqui usa `{ hidden: true }`.
describe("EmojiIconPicker", () => {
  // FUN-011 fala do emoji APARECENDO — os quatro testes abaixo só provavam
  // que `setPageIcon` foi chamado com os argumentos certos, nunca que o
  // glifo escolhido chega a aparecer na tela. Este é o mais direto dos dois
  // níveis: o próprio botão-gatilho (não seu `aria-label`, que é fixo) tem
  // que exibir `currentIcon` como texto visível — os testes de integração
  // em `PageWorkspace.test.tsx` e `Breadcrumb.test.tsx` cobrem os dois locais
  // que o critério de aceite cita (cabeçalho da página e trilha de navegação).
  it("FUN-011: o botão-gatilho mostra o ícone atual como texto visível, não só no aria-label", () => {
    const { rerender } = render(
      <EmojiIconPicker pageId="p1" currentIcon={null} triggerLabel="Ícone de Biologia" />,
    );

    const trigger = screen.getByRole("button", { name: "Ícone de Biologia" });
    // Sem ícone escolhido, o gatilho cai no glifo de página em branco — o
    // mesmo default que `Breadcrumb`/`PageTree` usam para páginas sem ícone.
    expect(trigger).toHaveTextContent("📄");

    rerender(<EmojiIconPicker pageId="p1" currentIcon="🧪" triggerLabel="Ícone de Biologia" />);

    expect(trigger).toHaveTextContent("🧪");
  });

  it("FUN-011: escolher um emoji da grade curada chama setPageIcon", async () => {
    const user = userEvent.setup();
    setPageIconMock.mockResolvedValue({
      id: "p1",
      parent_id: null,
      database_id: null,
      title: "Biologia",
      icon: "📚",
      position: "1",
      is_favorite: false,
      deleted_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    render(<EmojiIconPicker pageId="p1" currentIcon={null} triggerLabel="Ícone de Biologia" />);

    await user.click(screen.getByRole("button", { name: "Escolher ícone 📚", hidden: true }));

    expect(setPageIconMock).toHaveBeenCalledWith("p1", "📚");
  });

  it("FUN-011: digitar outro emoji no campo e confirmar também chama setPageIcon", async () => {
    const user = userEvent.setup();
    render(<EmojiIconPicker pageId="p1" currentIcon={null} triggerLabel="Ícone de Biologia" />);

    const input = screen.getByLabelText("Outro emoji", { selector: "input" });
    await user.type(input, "🦠");
    await user.click(screen.getByRole("button", { name: "Usar", hidden: true }));

    expect(setPageIconMock).toHaveBeenCalledWith("p1", "🦠");
  });

  it("com um ícone já escolhido, 'Remover ícone' chama setPageIcon com null", async () => {
    const user = userEvent.setup();
    render(<EmojiIconPicker pageId="p1" currentIcon="📚" triggerLabel="Ícone de Biologia" />);

    await user.click(screen.getByRole("button", { name: "Remover ícone", hidden: true }));

    expect(setPageIconMock).toHaveBeenCalledWith("p1", null);
  });

  it("sem ícone, não existe botão de remover", () => {
    render(<EmojiIconPicker pageId="p1" currentIcon={null} triggerLabel="Ícone de Biologia" />);

    expect(screen.queryByRole("button", { name: "Remover ícone", hidden: true })).not.toBeInTheDocument();
  });
});
