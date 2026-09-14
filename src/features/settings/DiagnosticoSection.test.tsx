import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppError, abrirPastaDeLogs } from "../../lib/ipc";
import { DiagnosticoSection } from "./DiagnosticoSection";
import { SettingsScreen } from "./SettingsScreen";

vi.mock("../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ipc")>();
  return { ...actual, abrirPastaDeLogs: vi.fn() };
});

const abrirMock = vi.mocked(abrirPastaDeLogs);

beforeEach(() => {
  abrirMock.mockReset();
});

describe("DiagnosticoSection", () => {
  it("abre a pasta de logs", async () => {
    abrirMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<DiagnosticoSection />);

    await user.click(screen.getByRole("button", { name: "Abrir pasta de logs" }));

    expect(abrirMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("mostra o motivo quando a pasta não abre", async () => {
    abrirMock.mockRejectedValue(new AppError({ kind: "config", message: "pasta de logs desconhecida" }));
    const user = userEvent.setup();
    render(<DiagnosticoSection />);

    await user.click(screen.getByRole("button", { name: "Abrir pasta de logs" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("pasta de logs desconhecida");
  });

  it("Configurações tem a seção Diagnóstico com o botão", async () => {
    const user = userEvent.setup();
    render(<SettingsScreen />);

    await user.click(screen.getByRole("button", { name: "Diagnóstico" }));

    expect(screen.getByRole("button", { name: "Abrir pasta de logs" })).toBeInTheDocument();
  });
});
