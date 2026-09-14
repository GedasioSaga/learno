import type { BlocoPlanejado } from "../../lib/ipc";
import { rotuloDoBloco } from "./format";

/** Quantos minutos antes do horário do bloco o lembrete aparece. */
export const ANTECEDENCIA_DO_LEMBRETE_MIN = 5;

export interface LembreteAgendado {
  blocoId: string;
  /** Daqui a quantos milissegundos o lembrete deve aparecer (0 = já). */
  emMs: number;
  titulo: string;
  corpo: string;
}

/**
 * Os lembretes que ainda cabem hoje, a partir de `agora` (hora LOCAL).
 *
 * Só bloco de `hoje` com horário. O lembrete sai [`ANTECEDENCIA_DO_LEMBRETE_MIN`]
 * antes do início; se o app abriu dentro dessa janela, sai na hora; se o bloco
 * já começou, não sai. Bloco já avisado nesta sessão fica de fora.
 */
export function lembretesDeHoje(
  blocos: BlocoPlanejado[],
  hoje: string,
  agora: Date,
  jaAvisados: ReadonlySet<string>,
): LembreteAgendado[] {
  const lembretes: LembreteAgendado[] = [];
  for (const bloco of blocos) {
    if (bloco.localDate !== hoje || !bloco.startLocalTime || jaAvisados.has(bloco.id)) continue;
    const [horas, minutos] = bloco.startLocalTime.split(":").map(Number);
    if (!Number.isInteger(horas) || !Number.isInteger(minutos)) continue;

    const inicio = new Date(agora);
    inicio.setHours(horas, minutos, 0, 0);
    if (inicio.getTime() <= agora.getTime()) continue;

    const aviso = inicio.getTime() - ANTECEDENCIA_DO_LEMBRETE_MIN * 60_000;
    lembretes.push({
      blocoId: bloco.id,
      emMs: Math.max(0, aviso - agora.getTime()),
      titulo: `Bloco às ${bloco.startLocalTime}`,
      corpo: `${rotuloDoBloco(bloco)} começa em ${ANTECEDENCIA_DO_LEMBRETE_MIN} min.`,
    });
  }
  return lembretes;
}
