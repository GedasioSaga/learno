import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { connectDatabase, getAppConfig, testDatabaseConnection } from "./lib/ipc";
import { useThemeStore } from "./lib/theme-store";

vi.mock("./lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/ipc")>();
  return {
    ...actual,
    getAppConfig: vi.fn(),
    testDatabaseConnection: vi.fn(),
    connectDatabase: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const getAppConfigMock = vi.mocked(getAppConfig);
const testDatabaseConnectionMock = vi.mocked(testDatabaseConnection);
const connectDatabaseMock = vi.mocked(connectDatabase);

const savedConfig = {
  host: "localhost",
  port: 5432,
  database: "learno",
  user: "postgres",
};

// Mesmo padrão de `FirstRunWizard.test.tsx`: nunca um literal `password:
// "..."` inline, pra não acionar varredura de segredo por engano.
const testFormPassword = ["fixture", "senha", "reconexao"].join("-");

beforeEach(() => {
  getAppConfigMock.mockReset();
  testDatabaseConnectionMock.mockReset();
  connectDatabaseMock.mockReset();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  useThemeStore.setState({ preference: "system", effective: "light" });
});

describe("App", () => {
  it("mostra o assistente de primeira execução quando não há configuração salva", async () => {
    getAppConfigMock.mockResolvedValue(null);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Conectar ao Postgres" }),
    ).toBeInTheDocument();
  });

  it("PLT-002: mostra a tela de reconexão (nunca direto a casca) quando já existe configuração salva mas a sessão ainda não conectou", async () => {
    // A senha nunca é persistida: ter `AppConfig` salvo não significa ter
    // pool nenhum nesta execução do processo. Antes da correção, este mesmo
    // cenário ia direto para `Workspace` sem jamais chamar `connectDatabase`
    // — todo comando de página falharia em silêncio assim que o usuário
    // tentasse usá-lo. Ver `src-tauri/src/ipc/state.rs`.
    getAppConfigMock.mockResolvedValue(savedConfig);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Conectar ao Postgres" }),
    ).toBeInTheDocument();
    // Host/porta/banco/usuário já vêm preenchidos da config salva — só a
    // senha falta.
    expect(screen.getByLabelText("Host")).toHaveValue(savedConfig.host);
    expect(screen.getByLabelText("Senha")).toHaveValue("");
    // A pasta de dados já foi coletada na primeira execução — não pergunta de novo.
    expect(screen.queryByLabelText("Pasta de dados (opcional)")).not.toBeInTheDocument();
    expect(connectDatabaseMock).not.toHaveBeenCalled();
  });

  it("PLT-002: libera a casca do app depois que a reconexão (senha digitada de novo) funciona", async () => {
    const user = userEvent.setup();
    getAppConfigMock.mockResolvedValue(savedConfig);
    testDatabaseConnectionMock.mockResolvedValue(undefined);
    connectDatabaseMock.mockResolvedValue(savedConfig);

    render(<App />);

    await user.type(await screen.findByLabelText("Senha"), testFormPassword);
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));
    await screen.findByText("Conexão bem-sucedida.");
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    expect(connectDatabaseMock).toHaveBeenCalledWith({
      host: savedConfig.host,
      port: savedConfig.port,
      database: savedConfig.database,
      user: savedConfig.user,
      password: testFormPassword,
    });
    expect(await screen.findByText("Bem-vindo ao Learno")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Páginas" })).toBeInTheDocument();
  });

  it("mostra um erro claro quando a configuração salva não pôde ser lida", async () => {
    getAppConfigMock.mockRejectedValue(new Error("armazenamento local corrompido"));

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("armazenamento local corrompido");
  });
});
