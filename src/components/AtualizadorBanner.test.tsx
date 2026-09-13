import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkMock, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));

import { AtualizadorBanner } from "./AtualizadorBanner";

type Evento =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

function updateFalso(downloadAndInstall: (onEvent: (e: Evento) => void) => Promise<void>) {
  return { version: "0.2.0", downloadAndInstall };
}

describe("AtualizadorBanner", () => {
  beforeEach(() => {
    checkMock.mockReset();
    relaunchMock.mockReset();
  });

  it("não mostra nada quando não há versão nova", async () => {
    checkMock.mockResolvedValue(null);
    const { container } = render(<AtualizadorBanner />);
    await waitFor(() => expect(checkMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("fica calado quando o check falha (offline, sem release)", async () => {
    checkMock.mockRejectedValue(new Error("network"));
    const { container } = render(<AtualizadorBanner />);
    await waitFor(() => expect(checkMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("avisa a versão nova, baixa, instala e reinicia", async () => {
    let terminar: () => void = () => {};
    checkMock.mockResolvedValue(
      updateFalso((onEvent) => {
        onEvent({ event: "Started", data: { contentLength: 200 } });
        onEvent({ event: "Progress", data: { chunkLength: 50 } });
        return new Promise<void>((resolve) => {
          terminar = resolve;
        });
      }),
    );
    render(<AtualizadorBanner />);

    await screen.findByText(/v0\.2\.0/);
    await userEvent.click(screen.getByRole("button", { name: "Atualizar agora" }));

    expect(await screen.findByText(/25%/)).toBeInTheDocument();
    expect(relaunchMock).not.toHaveBeenCalled();

    terminar();
    await waitFor(() => expect(relaunchMock).toHaveBeenCalledOnce());
  });

  it("mostra o erro e deixa tentar de novo quando o download falha", async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error("assinatura inválida")).mockResolvedValueOnce(undefined);
    checkMock.mockResolvedValue(updateFalso(download));
    render(<AtualizadorBanner />);

    await userEvent.click(await screen.findByRole("button", { name: "Atualizar agora" }));
    expect(await screen.findByText(/assinatura inválida/)).toBeInTheDocument();
    expect(relaunchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(relaunchMock).toHaveBeenCalledOnce());
  });

  it("'Depois' esconde o aviso", async () => {
    checkMock.mockResolvedValue(updateFalso(() => Promise.resolve()));
    const { container } = render(<AtualizadorBanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Depois" }));
    expect(container).toBeEmptyDOMElement();
  });
});
