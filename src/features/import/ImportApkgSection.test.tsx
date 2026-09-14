import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportApkgSection } from "./ImportApkgSection";
import { importApkg, type RelatorioDeImportacao } from "../../lib/ipc";
import { open } from "@tauri-apps/plugin-dialog";
import { useCartoesStore } from "../cartoes/store";

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

const BOTAO = "Importar do Anki (.apkg ou .colpkg)";

function relatorio(overrides: Partial<RelatorioDeImportacao> = {}): RelatorioDeImportacao {
  return {
    notasImportadas: 0,
    notasJaExistentes: 0,
    notasSemCartao: 0,
    cartoesImportados: 0,
    revisoesImportadas: 0,
    revisoesIgnoradas: 0,
    baralhosCriados: 0,
    tiposDeNotaCriados: 0,
    midiasIgnoradas: 0,
    ...overrides,
  };
}

beforeEach(() => {
  importApkgMock.mockReset();
  openMock.mockReset();
});

describe("ImportApkgSection", () => {
  it("abre o diálogo filtrado por .apkg e .colpkg e resume o que entrou", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("C:\\Users\\estudante\\Desktop\\baralho-historia.apkg");
    importApkgMock.mockResolvedValue(
      relatorio({ notasImportadas: 12, cartoesImportados: 15, revisoesImportadas: 30, baralhosCriados: 2 }),
    );

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: BOTAO }));

    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "Anki", extensions: ["apkg", "colpkg"] }] }),
    );
    expect(importApkgMock).toHaveBeenCalledWith("C:\\Users\\estudante\\Desktop\\baralho-historia.apkg");
    const resumo = await screen.findByRole("status");
    expect(resumo).toHaveTextContent('"baralho-historia.apkg": 12 nota(s) e 15 cartão(ões) importados.');
    expect(resumo).toHaveTextContent("30 revisão(ões) do histórico.");
    expect(resumo).toHaveTextContent("2 baralho(s) novo(s).");
    expect(resumo).not.toHaveTextContent("mídia");
    expect(resumo).not.toHaveTextContent("pulada");
  });

  it("reimportar o mesmo arquivo diz que as notas foram puladas e avisa da mídia deixada de fora", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("C:\\colecao.colpkg");
    importApkgMock.mockResolvedValue(relatorio({ notasJaExistentes: 24029, midiasIgnoradas: 3 }));

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: BOTAO }));

    const resumo = await screen.findByRole("status");
    expect(resumo).toHaveTextContent('"colecao.colpkg": 0 nota(s) e 0 cartão(ões) importados.');
    expect(resumo).toHaveTextContent("24029 nota(s) já importada(s) antes: pulada(s), sem mexer no progresso.");
    expect(resumo).toHaveTextContent("3 arquivo(s) de mídia não importado(s)");
  });

  it("não chama import_apkg quando o usuário fecha o diálogo sem escolher arquivo", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue(null);

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: BOTAO }));

    expect(importApkgMock).not.toHaveBeenCalled();
  });

  it("mostra o erro do backend quando o arquivo não é um pacote do Anki", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("C:\\baralho-corrompido.apkg");
    importApkgMock.mockRejectedValue(
      new Error("entrada inválida: baralho-corrompido.apkg não é um pacote do Anki válido: invalid Zip archive"),
    );

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: BOTAO }));

    expect(await screen.findByRole("alert")).toHaveTextContent("não é um pacote do Anki válido");
  });

  // PLT-013: também cobre o erro que o backup pré-importação em si pode
  // produzir (disco cheio, permissão negada na pasta).
  it("mostra o erro quando o backup pré-importação falha", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("C:\\baralho.apkg");
    importApkgMock.mockRejectedValue(
      new Error("disco cheio — não foi possível gravar a cópia de segurança antes do import"),
    );

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: BOTAO }));

    expect(await screen.findByRole("alert")).toHaveTextContent("disco cheio");
  });

  it("depois de importar, a store de Cartões volta a buscar os tipos de nota", async () => {
    const user = userEvent.setup();
    useCartoesStore.setState({ noteTypesStatus: "ready" });
    openMock.mockResolvedValue("C:\\baralho.apkg");
    importApkgMock.mockResolvedValue(relatorio({ notasImportadas: 1, cartoesImportados: 1, tiposDeNotaCriados: 1 }));

    render(<ImportApkgSection />);
    await user.click(screen.getByRole("button", { name: BOTAO }));
    await screen.findByRole("status");

    expect(useCartoesStore.getState().noteTypesStatus).toBe("idle");
  });

  // O resto da tela continua reagindo a clique enquanto a importação não
  // termina — nada trava esperando `import_apkg` resolver. `resolveImport` só
  // é chamado depois de já termos clicado em outro botão da tela.
  it("mantém a UI respondendo a cliques enquanto a importação está em andamento", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue("C:\\baralho-grande.apkg");
    let resolveImport: (value: RelatorioDeImportacao) => void = () => {};
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

    await user.click(screen.getByRole("button", { name: BOTAO }));

    // Ainda em andamento: o botão de importar virou o rótulo de progresso...
    const importingButton = await screen.findByRole("button", { name: /Importando/ });
    expect(importingButton).toBeDisabled();
    // ...mas o resto da tela não travou: este outro botão aceita o clique
    // sem exceção nem timeout, mesmo com a Promise ainda pendente.
    await user.click(screen.getByRole("button", { name: "outro controle da tela" }));

    resolveImport(relatorio({ notasImportadas: 5, cartoesImportados: 5 }));
    expect(await screen.findByRole("status")).toHaveTextContent("5 nota(s) e 5 cartão(ões) importados.");
  });
});
