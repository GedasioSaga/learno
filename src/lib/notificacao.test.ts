import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { avisar, esquecerPermissaoDeAviso } from "./notificacao";
import { registrarErro } from "./registro-de-erros";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("./registro-de-erros", () => ({ registrarErro: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  esquecerPermissaoDeAviso();
});

describe("avisar", () => {
  it("com permissão já dada, mostra o aviso sem pedir de novo", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(true);

    await avisar("Foco concluído", "Hora da pausa curta.");

    expect(requestPermission).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledWith({ title: "Foco concluído", body: "Hora da pausa curta." });
  });

  it("pede a permissão uma vez só na sessão, e recusada não mostra nem pede de novo", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");

    await avisar("a", "b");
    await avisar("c", "d");

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("permissão concedida no pedido mostra o aviso", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("granted");

    await avisar("Bloco em 5 min", "Redação às 14:00");

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("falha do plugin não lança, vai para o log, e a próxima tentativa pergunta de novo", async () => {
    vi.mocked(isPermissionGranted).mockRejectedValueOnce(new Error("fora do Tauri")).mockResolvedValue(true);

    await expect(avisar("a", "b")).resolves.toBeUndefined();
    expect(registrarErro).toHaveBeenCalledWith("promessa", expect.any(Error));

    await avisar("c", "d");
    expect(sendNotification).toHaveBeenCalledWith({ title: "c", body: "d" });
  });
});
