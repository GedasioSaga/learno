import { useEffect, useRef } from "react";
import { semanaDeEstudo } from "../../lib/ipc";
import { avisar } from "../../lib/notificacao";
import { registrarErro } from "../../lib/registro-de-erros";
import { hojeLocal, inicioDaSemanaLocal } from "./date-utils";
import { lembretesDeHoje } from "./lembrete-de-blocos";

/** De quanto em quanto tempo o plano de hoje é relido, para pegar bloco criado ou movido depois de o app abrir. */
export const RELEITURA_DO_PLANO_MS = 10 * 60_000;

/**
 * Agenda, enquanto o app está aberto, o lembrete dos blocos de hoje que têm
 * horário (`lembretesDeHoje`). App fechado não lembra de nada: não há
 * agendador fora do processo, por decisão do usuário (14/09/2026).
 *
 * Cada releitura cancela os timers anteriores e agenda de novo, então bloco
 * movido ou apagado não dispara aviso velho. Bloco já avisado não avisa de
 * novo na mesma sessão.
 */
export function useLembreteDeBlocos(): void {
  const avisados = useRef(new Set<string>());

  useEffect(() => {
    let cancelado = false;
    let timers: number[] = [];
    const limparTimers = () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers = [];
    };

    async function reagendar() {
      try {
        const semana = await semanaDeEstudo(inicioDaSemanaLocal());
        if (cancelado) return;
        const hoje = hojeLocal();
        const blocos = semana.dias.find((dia) => dia.data === hoje)?.blocos ?? [];
        limparTimers();
        for (const lembrete of lembretesDeHoje(blocos, hoje, new Date(), avisados.current)) {
          timers.push(
            window.setTimeout(() => {
              avisados.current.add(lembrete.blocoId);
              void avisar(lembrete.titulo, lembrete.corpo);
            }, lembrete.emMs),
          );
        }
      } catch (erro) {
        registrarErro("promessa", erro);
      }
    }

    void reagendar();
    const releitura = window.setInterval(() => void reagendar(), RELEITURA_DO_PLANO_MS);
    return () => {
      cancelado = true;
      limparTimers();
      window.clearInterval(releitura);
    };
  }, []);
}
