import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportApkgSection } from "./ImportApkgSection";
import { importApkg } from "../../lib/ipc";
import { open } from "@tauri-apps/plugin-dialog";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    importApkg: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const importApkgMock = vi.mocked(importApkg);
const openMock = vi.mocked(open);

beforeEach(() => {
  importApkgMock.mockReset();
  openMock.mockReset();
});

describe("ImportApkgSection", () => {
  it("abre o diálogo de arquivo filtrado por .apkg e importa o caminho escolhido", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("C:\\Users\\estudante\\Desktop\\baralho-historia.apkg");
    importApkgMock.mockResolvedValue({ notes_imported: 0 });

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: "Importar baralho do Anki (.apkg)" }));

    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "Baralho do Anki", extensions: ["apkg"] }] }),
    );
    expect(importApkgMock).toHaveBeenCalledWith("C:\\Users\\estudante\\Desktop\\baralho-historia.apkg");
    expect(
      await screen.findByText('"baralho-historia.apkg": 0 nota(s) importada(s).'),
    ).toBeInTheDocument();
  });

  it("não chama import_apkg quando o usuário fecha o diálogo sem escolher arquivo", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue(null);

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: "Importar baralho do Anki (.apkg)" }));

    expect(importApkgMock).not.toHaveBeenCalled();
  });

  it("mostra o erro tipado do backend quando o sidecar rejeita o arquivo", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("C:\\baralho-corrompido.apkg");
    importApkgMock.mockRejectedValue(new Error("[apkg_invalido] não é um pacote .apkg válido"));

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: "Importar baralho do Anki (.apkg)" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("não é um pacote .apkg válido");
  });

  // PLT-013: também cobre o erro que o backup pré-import em si pode
  // produzir (disco cheio, permissão negada na pasta) — o sidecar nem chega
  // a ser chamado nesse caso.
  it("mostra o erro quando o backup pré-import falha e nunca chega a chamar o sidecar", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("C:\\baralho.apkg");
    importApkgMock.mockRejectedValue(
      new Error("disco cheio — não foi possível gravar a cópia de segurança antes do import"),
    );

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: "Importar baralho do Anki (.apkg)" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("disco cheio");
  });

  // Prova o critério de aceite de PLT-004 na UI: enquanto o sidecar ainda
  // não respondeu, o resto da tela continua reagindo a clique — nada trava
  // esperando `import_apkg` resolver. `resolveImport` só é chamado depois de
  // já termos clicado em outro botão da tela.
  it("mantém a UI respondendo a cliques enquanto o import está em andamento", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("C:\\baralho-grande.apkg");
    let resolveImport: (value: { notes_imported: number }) => void = () => {};
    importApkgMock.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );

    render(
      <div>
        <ImportApkgSection />
        <button type="button">outro controle da tela</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Importar baralho do Anki (.apkg)" }));

    // Ainda em andamento: o botão de import virou o rótulo de progresso...
    const importingButton = await screen.findByRole("button", { name: /Importando/ });
    expect(importingButton).toBeDisabled();
    // ...mas o resto da tela não travou: este outro botão aceita o clique
    // sem exceção nem timeout, mesmo com a Promise do sidecar ainda pendente.
    await user.click(screen.getByRole("button", { name: "outro controle da tela" }));

    resolveImport({ notes_imported: 0 });
    expect(await screen.findByRole("status")).toHaveTextContent("0 nota(s) importada(s)");
  });
});
