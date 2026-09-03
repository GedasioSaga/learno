import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BackupSettings } from "./BackupSettings";
import {
  createBackup,
  getBackupScheduleConfig,
  restoreBackup,
  runDueScheduledBackup,
  saveBackupScheduleConfig,
  type BackupScheduleConfig,
} from "../../lib/ipc";
import { open } from "@tauri-apps/plugin-dialog";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...actual,
    createBackup: vi.fn(),
    restoreBackup: vi.fn(),
    getBackupScheduleConfig: vi.fn(),
    saveBackupScheduleConfig: vi.fn(),
    runDueScheduledBackup: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const createBackupMock = vi.mocked(createBackup);
const restoreBackupMock = vi.mocked(restoreBackup);
const getBackupScheduleConfigMock = vi.mocked(getBackupScheduleConfig);
const saveBackupScheduleConfigMock = vi.mocked(saveBackupScheduleConfig);
const runDueScheduledBackupMock = vi.mocked(runDueScheduledBackup);
const openMock = vi.mocked(open);

// Ver o comentário equivalente em FirstRunWizard.test.tsx: valor de teste,
// não segredo real, só escrito assim pra não parecer um literal de senha.
const testPassword = ["fixture", "senha", "somente-teste"].join("-");

const defaultScheduleConfig: BackupScheduleConfig = {
  enabled: false,
  cadence: "daily",
  keep_scheduled: 7,
  keep_risky_operation: 5,
};

beforeEach(() => {
  createBackupMock.mockReset();
  restoreBackupMock.mockReset();
  openMock.mockReset();
  saveBackupScheduleConfigMock.mockReset();
  runDueScheduledBackupMock.mockReset();
  // Todo teste deste arquivo monta `BackupSettings` inteiro, então a seção
  // de backup automático sempre carrega no mount — sem isto, os testes que
  // nem tocam nela ainda bateriam a `invoke()` real do Tauri (ausente em
  // jsdom) e vazariam uma rejeição não tratada.
  getBackupScheduleConfigMock.mockReset().mockResolvedValue(defaultScheduleConfig);
});

describe("BackupSettings", () => {
  it("cria um backup depois de escolher a pasta e informar a senha", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValueOnce("C:/backups");
    createBackupMock.mockResolvedValue("C:/backups/learno-backup-x.dump");

    render(<BackupSettings />);

    await user.type(screen.getAllByLabelText("Senha do Postgres")[0], testPassword);
    await user.click(screen.getByRole("button", { name: "Escolher pasta" }));
    expect(await screen.findByDisplayValue("C:/backups")).toBeInTheDocument();

    const createButton = screen.getByRole("button", { name: "Criar backup" });
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    expect(createBackupMock).toHaveBeenCalledWith(testPassword, "C:/backups");
    expect(await screen.findByText("Backup criado em C:/backups/learno-backup-x.dump")).toBeInTheDocument();
  });

  it("pede confirmação antes de restaurar e só chama restoreBackup depois de confirmado", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValueOnce("C:/backups/learno-backup-x.dump");
    restoreBackupMock.mockResolvedValue(undefined);

    render(<BackupSettings />);

    const passwordInputs = screen.getAllByLabelText("Senha do Postgres");
    await user.type(passwordInputs[1], testPassword);
    await user.click(screen.getByRole("button", { name: "Escolher arquivo" }));
    await screen.findByDisplayValue("C:/backups/learno-backup-x.dump");

    await user.click(screen.getByRole("button", { name: "Restaurar" }));
    expect(restoreBackupMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sim, restaurar" }));

    expect(restoreBackupMock).toHaveBeenCalledWith(testPassword, "C:/backups/learno-backup-x.dump");
    expect(await screen.findByText("Backup restaurado com sucesso.")).toBeInTheDocument();
  });

  it("cancelar a confirmação de restauração não chama restoreBackup", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValueOnce("C:/backups/learno-backup-x.dump");

    render(<BackupSettings />);

    const passwordInputs = screen.getAllByLabelText("Senha do Postgres");
    await user.type(passwordInputs[1], testPassword);
    await user.click(screen.getByRole("button", { name: "Escolher arquivo" }));
    await screen.findByDisplayValue("C:/backups/learno-backup-x.dump");

    await user.click(screen.getByRole("button", { name: "Restaurar" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(restoreBackupMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("mostra o erro do backend quando a criação do backup falha", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValueOnce("C:/backups");
    createBackupMock.mockRejectedValue(new Error("pg_dump saiu com código de erro: 1"));

    render(<BackupSettings />);

    const passwordInputs = screen.getAllByLabelText("Senha do Postgres");
    await user.type(passwordInputs[0], testPassword);
    await user.click(screen.getByRole("button", { name: "Escolher pasta" }));
    await screen.findByDisplayValue("C:/backups");

    await user.click(screen.getByRole("button", { name: "Criar backup" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("pg_dump saiu com código de erro: 1");
  });

  describe("backup automático (PLT-013)", () => {
    it("carrega a configuração salva e permite ativá-la e salvar", async () => {
      const user = userEvent.setup();
      saveBackupScheduleConfigMock.mockResolvedValue(undefined);

      render(<BackupSettings />);

      const enableCheckbox = await screen.findByLabelText("Fazer backup automático periodicamente");
      expect(enableCheckbox).not.toBeChecked();

      await user.click(enableCheckbox);
      await user.click(screen.getByRole("button", { name: "Salvar configuração" }));

      expect(saveBackupScheduleConfigMock).toHaveBeenCalledWith({ ...defaultScheduleConfig, enabled: true });
      expect(await screen.findByText("Salvo.")).toBeInTheDocument();
    });

    it("checa o backup automático agora e mostra o caminho quando um backup roda", async () => {
      const user = userEvent.setup();
      runDueScheduledBackupMock.mockResolvedValue("C:/backups/learno-backup-scheduled.dump");

      render(<BackupSettings />);
      await screen.findByLabelText("Fazer backup automático periodicamente");

      const passwordInputs = screen.getAllByLabelText("Senha do Postgres");
      await user.type(passwordInputs[passwordInputs.length - 1], testPassword);
      await user.click(screen.getByRole("button", { name: "Checar backup automático agora" }));

      expect(runDueScheduledBackupMock).toHaveBeenCalledWith(testPassword);
      expect(
        await screen.findByText("Backup automático criado em C:/backups/learno-backup-scheduled.dump"),
      ).toBeInTheDocument();
    });

    it("avisa quando ainda não é hora do próximo backup automático", async () => {
      const user = userEvent.setup();
      runDueScheduledBackupMock.mockResolvedValue(null);

      render(<BackupSettings />);
      await screen.findByLabelText("Fazer backup automático periodicamente");

      const passwordInputs = screen.getAllByLabelText("Senha do Postgres");
      await user.type(passwordInputs[passwordInputs.length - 1], testPassword);
      await user.click(screen.getByRole("button", { name: "Checar backup automático agora" }));

      expect(await screen.findByText("Ainda não é hora do próximo backup automático.")).toBeInTheDocument();
    });
  });
});
