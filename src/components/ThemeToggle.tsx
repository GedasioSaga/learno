import { useThemeStore } from "../lib/theme-store";
import { acharTema, TEMA_CLARO_DO_SISTEMA } from "../lib/themes";
import { BotaoDeIcone } from "./BotaoDeIcone";

interface ThemeToggleProps {
  /**
   * `linha` (padrão): botão de largura inteira com ícone e texto, para uma
   * lista de ações. `icone`: só o emoji, do tamanho mínimo de alvo, para o
   * rodapé do rail de seções — o texto vira `aria-label`, então o nome
   * acessível é o mesmo nas duas variantes.
   */
  variante?: "linha" | "icone";
}

/**
 * Atalho para alternar entre claro e escuro, no rodapé do rail.
 *
 * Continua existindo mesmo com cinco temas porque alternar claro/escuro é o
 * gesto rápido (a luz do quarto mudou), enquanto ESCOLHER um tema é decisão
 * rara e mora em Configurações > Aparência.
 *
 * Sem `aria-pressed`: com cinco temas isto não é mais um interruptor de dois
 * estados, e sim um botão que leva ao outro extremo. O rótulo diz para onde
 * vai, não onde está — que é o que um botão de ação deve dizer.
 */
export function ThemeToggle({ variante = "linha" }: ThemeToggleProps) {
  const temaEfetivo = useThemeStore((estado) => estado.temaEfetivo);
  const ultimoEscuro = useThemeStore((estado) => estado.ultimoEscuro);
  const alternar = useThemeStore((estado) => estado.alternar);

  const estaNoEscuro = acharTema(temaEfetivo)?.aparencia === "escura";
  const destino = estaNoEscuro ? TEMA_CLARO_DO_SISTEMA : ultimoEscuro;
  const nomeDoDestino = acharTema(destino)?.nome ?? "outro tema";
  const rotulo = estaNoEscuro ? "Tema claro" : "Tema escuro";
  const dica = `Alternar para ${nomeDoDestino}`;

  if (variante === "icone") {
    return (
      <BotaoDeIcone rotulo={rotulo} title={dica} onClick={alternar}>
        <span aria-hidden="true" className="text-base leading-none">
          {estaNoEscuro ? "☀️" : "🌙"}
        </span>
      </BotaoDeIcone>
    );
  }

  return (
    <button
      type="button"
      onClick={alternar}
      title={dica}
      // Fantasma, como as outras ações da barra lateral. Com borda e
      // superfície próprias ele virava o elemento mais gritante do rodapé —
      // um atalho de conveniência chamando mais atenção que "Nova página".
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-ink-muted transition-colors duration-150 ease-out hover:bg-surface-raised hover:text-ink"
    >
      <span aria-hidden="true">{estaNoEscuro ? "☀️" : "🌙"}</span>
      {rotulo}
    </button>
  );
}
