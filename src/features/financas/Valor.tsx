import { formatarReais } from "./dinheiro";

interface ValorProps {
  centavos: number;
  /** Mostra `+`/`−` e pinta negativo. Sem isto o valor sai sem sinal, como num campo. */
  comSinal?: boolean;
  className?: string;
}

/**
 * Um valor em reais. Negativo nunca depende só da cor: leva o sinal `−` no
 * texto (regra do projeto — ver `prazos/format.ts`).
 */
export function Valor({ centavos, comSinal = false, className = "" }: ValorProps) {
  const negativo = centavos < 0;
  const texto = formatarReais(Math.abs(centavos));
  const sinal = negativo ? "−" : comSinal && centavos > 0 ? "+" : "";
  const cor = negativo ? "text-terracotta-ink" : "";
  return <span className={`tabular-nums ${cor} ${className}`.trim()}>{`${sinal}${texto}`}</span>;
}
