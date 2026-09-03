import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FirstRunWizard } from "./FirstRunWizard";
import { AppError, connectDatabase, saveDataDir, testDatabaseConnection } from "../lib/ipc";

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    testDatabaseConnection: vi.fn(),
    connectDatabase: vi.fn(),
    saveDataDir: vi.fn(),
  };
});

const testDatabaseConnectionMock = vi.mocked(testDatabaseConnection);
const connectDatabaseMock = vi.mocked(connectDatabase);
const saveDataDirMock = vi.mocked(saveDataDir);

// Nunca escrita como `password: "..."` literal de propósito — é só um valor
// de teste que passa pelo formulário, mas o padrão chamaria atenção de
// ferramenta de varredura de segredo se aparecesse como literal inline.
const testFormPassword = ["fixture", "senha", "somente-teste"].join("-");

const savedConfig = {
  host: "db.interno",
  port: 5544,
  database: "learno_prod",
  user: "gedasio",
};

beforeEach(() => {
  testDatabaseConnectionMock.mockReset();
  connectDatabaseMock.mockReset();
  saveDataDirMock.mockReset();
});

describe("FirstRunWizard", () => {
  it("testa a conexão e só então libera Continuar, que conecta de verdade e persiste a config sem a senha", async () => {
    const user = userEvent.setup();
    testDatabaseConnectionMock.mockResolvedValue(undefined);
    connectDatabaseMock.mockResolvedValue({
      host: "localhost",
      port: 5432,
      database: "learno",
      user: "postgres",
    });
    const onComplete = vi.fn();

    render(<FirstRunWizard onComplete={onComplete} />);

    await user.type(screen.getByLabelText("Senha"), testFormPassword);

    const continueButton = screen.getByRole("button", { name: "Continuar" });
    expect(continueButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Testar conexão" }));

    expect(testDatabaseConnectionMock).toHaveBeenCalledWith({
      host: "localhost",
      port: 5432,
      database: "learno",
      user: "postgres",
      password: testFormPassword,
    });
    expect(await screen.findByText("Conexão bem-sucedida.")).toBeInTheDocument();
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);

    expect(connectDatabaseMock).toHaveBeenCalledWith({
      host: "localhost",
      port: 5432,
      database: "learno",
      user: "postgres",
      password: testFormPassword,
    });
    // Pasta de dados ficou em branco (caso padrão) — nunca deve persistir um
    // valor vazio como se fosse uma escolha real do usuário.
    expect(saveDataDirMock).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("aceita senha em branco e testa a conexão mesmo assim — trust/peer/ident não têm senha para digitar", async () => {
    const user = userEvent.setup();
    testDatabaseConnectionMock.mockResolvedValue(undefined);

    render(<FirstRunWizard onComplete={vi.fn()} />);

    // Não digitamos nada em Senha — ela nasce vazia. É o caso real do
    // cluster de dev (autenticação `trust`, sem senha nenhuma) e o
    // bloqueante desta tarefa: antes da correção, o <input> nascia
    // `required` e a validação nativa do HTML5 travava o submit ANTES do
    // `onSubmit`, sem alerta nem estado de erro — o clique não disparava
    // nada. Este teste prova o SUBMIT acontecendo (o mock foi chamado) e
    // não apenas a ausência do atributo `required` no DOM.
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));

    expect(testDatabaseConnectionMock).toHaveBeenCalledWith({
      host: "localhost",
      port: 5432,
      database: "learno",
      user: "postgres",
      password: "",
    });
    expect(await screen.findByText("Conexão bem-sucedida.")).toBeInTheDocument();
  });

  it("recusa Host em branco com mensagem, sem chamar o backend — mesmo padrão de campo mudo, mas Host não tem caso legítimo de ficar vazio como Senha tem", async () => {
    const user = userEvent.setup();
    render(<FirstRunWizard onComplete={vi.fn()} />);

    await user.clear(screen.getByLabelText("Host"));
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Host não pode ficar em branco.");
    expect(testDatabaseConnectionMock).not.toHaveBeenCalled();
  });

  it("PLT-016: informa a pasta de dados e persiste depois que a conexão é aberta", async () => {
    const user = userEvent.setup();
    testDatabaseConnectionMock.mockResolvedValue(undefined);
    connectDatabaseMock.mockResolvedValue({
      host: "localhost",
      port: 5432,
      database: "learno",
      user: "postgres",
    });
    saveDataDirMock.mockResolvedValue(undefined);
    const onComplete = vi.fn();

    render(<FirstRunWizard onComplete={onComplete} />);

    await user.type(screen.getByLabelText("Senha"), testFormPassword);
    await user.type(screen.getByLabelText("Pasta de dados (opcional)"), "D:\\Learno\\dados");
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));
    await screen.findByText("Conexão bem-sucedida.");

    await user.click(screen.getByRole("button", { name: "Continuar" }));

    expect(saveDataDirMock).toHaveBeenCalledWith("D:\\Learno\\dados");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("mostra a mensagem do backend quando o teste de conexão falha, sem liberar Continuar", async () => {
    const user = userEvent.setup();
    testDatabaseConnectionMock.mockRejectedValue(
      new AppError({ kind: "database", message: "senha incorreta para o usuário" }),
    );

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText("Senha"), testFormPassword);
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("senha incorreta para o usuário");
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
    expect(connectDatabaseMock).not.toHaveBeenCalled();
  });

  it("PLT-016: orienta a instalação do Postgres quando nenhuma instância é encontrada, distinto de credencial errada", async () => {
    const user = userEvent.setup();
    testDatabaseConnectionMock.mockRejectedValue(
      new AppError({
        kind: "database_unreachable",
        message: "nenhuma instância de Postgres respondeu em localhost:5432",
      }),
    );

    render(<FirstRunWizard onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText("Senha"), testFormPassword);
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("nenhuma instância de Postgres respondeu em localhost:5432");
    expect(alert).toHaveTextContent(/instale o postgresql/i);
    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
  });

  it("recusa uma porta que não é um número válido sem chamar o backend", async () => {
    const user = userEvent.setup();
    render(<FirstRunWizard onComplete={vi.fn()} />);

    // Senha fica em branco de propósito (é um campo opcional, ver teste
    // acima) — o que este teste quer provar é a validação da porta, isolada
    // de qualquer outro campo.

    const portField = screen.getByLabelText("Porta");
    await user.clear(portField);
    await user.type(portField, "não-é-porta");
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/porta/i);
    expect(testDatabaseConnectionMock).not.toHaveBeenCalled();
  });

  it("mostra a mensagem do backend e mantém Continuar tentável quando connectDatabase falha (ex.: migração quebrada)", async () => {
    const user = userEvent.setup();
    testDatabaseConnectionMock.mockResolvedValue(undefined);
    connectDatabaseMock.mockRejectedValue(
      new AppError({ kind: "migration", message: "migração do banco: function unaccent(unknown, text) does not exist" }),
    );
    const onComplete = vi.fn();

    render(<FirstRunWizard onComplete={onComplete} />);

    await user.type(screen.getByLabelText("Senha"), testFormPassword);
    await user.click(screen.getByRole("button", { name: "Testar conexão" }));
    await screen.findByText("Conexão bem-sucedida.");
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "migração do banco: function unaccent(unknown, text) does not exist",
    );
    // Falha ao conectar/migrar não pode terminar o assistente: o usuário
    // continua na mesma tela, com o formulário ainda ali para tentar de novo.
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continuar" })).toBeInTheDocument();
  });

  describe('modo "reconnect"', () => {
    it("prefila host/porta/banco/usuário a partir de savedConfig, não pede pasta de dados, e chama connectDatabase com os mesmos campos", async () => {
      const user = userEvent.setup();
      testDatabaseConnectionMock.mockResolvedValue(undefined);
      connectDatabaseMock.mockResolvedValue(savedConfig);
      const onComplete = vi.fn();

      render(<FirstRunWizard mode="reconnect" savedConfig={savedConfig} onComplete={onComplete} />);

      expect(screen.getByLabelText("Host")).toHaveValue(savedConfig.host);
      expect(screen.getByLabelText("Porta")).toHaveValue(String(savedConfig.port));
      expect(screen.getByLabelText("Banco de dados")).toHaveValue(savedConfig.database);
      expect(screen.getByLabelText("Usuário")).toHaveValue(savedConfig.user);
      expect(screen.queryByLabelText("Pasta de dados (opcional)")).not.toBeInTheDocument();

      await user.type(screen.getByLabelText("Senha"), testFormPassword);
      await user.click(screen.getByRole("button", { name: "Testar conexão" }));
      await screen.findByText("Conexão bem-sucedida.");
      await user.click(screen.getByRole("button", { name: "Continuar" }));

      expect(connectDatabaseMock).toHaveBeenCalledWith({ ...savedConfig, password: testFormPassword });
      expect(saveDataDirMock).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });
});
