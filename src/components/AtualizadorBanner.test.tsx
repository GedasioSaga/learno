import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkMock, relaunchMock, encerrarSidecarMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
  encerrarSidecarMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));
vi.mock("../lib/ipc", () => ({ encerrarSidecarParaAtualizar: encerrarSidecarMock }));

import { AtualizadorBanner } from "./AtualizadorBanner";

type Evento =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

function updateFalso(
  download: (onEvent: (e: Evento) => void) => Promise<void>,
  install: () => Promise<void> = () => Promise.resolve(),
) {
  return { version: "0.2.0", download, install };
}

describe("AtualizadorBanner", () => {
  beforeEach(() => {
    checkMock.mockReset();
    relaunchMock.mockReset();
    encerrarSidecarMock.mockReset().mockResolvedValue(undefined);
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

  it("baixa, desliga o sidecar, instala e reinicia — nessa ordem", async () => {
    const ordem: string[] = [];
    let terminarDownload: () => void = () => {};
    const install = vi.fn(async () => {
      ordem.push("install");
    });
    encerrarSidecarMock.mockImplementation(async () => {
      ordem.push("sidecar");
    });
    relaunchMock.mockImplementation(async () => {
      ordem.push("relaunch");
    });
    checkMock.mockResolvedValue(
      updateFalso((onEvent) => {
        onEvent({ event: "Started", data: { contentLength: 200 } });
        onEvent({ event: "Progress", data: { chunkLength: 50 } });
        return new Promise<void>((resolve) => {
          terminarDownload = resolve;
        });
      }, install),
    );
    render(<AtualizadorBanner />);

    await screen.findByText(/v0\.2\.0/);
    await userEvent.click(screen.getByRole("button", { name: "Atualizar agora" }));

    expect(await screen.findByText(/25%/)).toBeInTheDocument();
    expect(encerrarSidecarMock).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();

    terminarDownload();
    await waitFor(() => expect(ordem).toEqual(["sidecar", "install", "relaunch"]));
  });

  it("sem contentLength a barra não finge estar cheia", async () => {
    checkMock.mockResolvedValue(
      updateFalso((onEvent) => {
        onEvent({ event: "Started", data: {} });
        return new Promise<void>(() => {});
      }),
    );
    render(<AtualizadorBanner />);
    await userEvent.click(await screen.findByRole("button", { name: "Atualizar agora" }));
    const barra = await screen.findByRole("progressbar");
    expect(barra).not.toHaveAttribute("aria-valuenow");
    expect(barra.firstElementChild).not.toHaveStyle({ width: "100%" });
  });

  it("mostra o erro e deixa tentar de novo quando o download falha", async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error("assinatura inválida"))
      .mockResolvedValueOnce(undefined);
    checkMock.mockResolvedValue(updateFalso(download));
    render(<AtualizadorBanner />);

    await userEvent.click(await screen.findByRole("button", { name: "Atualizar agora" }));
    expect(await screen.findByText(/assinatura inválida/)).toBeInTheDocument();
    expect(encerrarSidecarMock).not.toHaveBeenCalled();
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
