import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { registrarErro } from "./registro-de-erros";

/**
 * A resposta da permissão vale para a sessão inteira: pedir de novo a cada
 * aviso incomodaria quem recusou. Quem liberar depois nas configurações do
 * Windows passa a receber avisos na próxima abertura do app.
 */
let permissao: Promise<boolean> | null = null;

async function obterPermissao(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

/**
 * Mostra uma notificação do sistema. Nunca lança: sem permissão, fora do Tauri
 * ou com o plugin falhando, o app segue igual, e a falha vai para o log.
 */
export async function avisar(titulo: string, corpo: string): Promise<void> {
  try {
    permissao ??= obterPermissao();
    if (!(await permissao)) return;
    sendNotification({ title: titulo, body: corpo });
  } catch (erro) {
    permissao = null;
    registrarErro("promessa", erro);
  }
}

/** Esquece a permissão guardada, para um teste não herdar a resposta do anterior. */
export function esquecerPermissaoDeAviso(): void {
  permissao = null;
}
