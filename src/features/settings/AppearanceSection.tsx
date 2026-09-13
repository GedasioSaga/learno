import { useId } from "react";
import { useThemeStore } from "../../lib/theme-store";
import { SEGUIR_O_SISTEMA, TEMAS } from "../../lib/themes";

/**
 * Escolha de tema, em Configurações > Aparência.
 *
 * ## A amostra se pinta sozinha
 *
 * Cada opção mostra um mini card com as cores DAQUELE tema, e nenhuma cor
 * aparece neste arquivo. O truque é o seletor: `src/styles/theme.css` declara
 * cada tema como `[data-theme="<id>"]`, sem `:root` na frente, então um `<div
 * data-theme="grafite">` aqui no meio da página recebe o bloco inteiro de
 * tokens e tudo que estiver dentro dele já sai pintado.
 *
 * Isso não é elegância à toa: a alternativa seria repetir os hex de cinco
 * temas em TypeScript, e essa cópia ficaria para trás na primeira vez que
 * alguém acertasse um contraste no CSS. Amostra que mente sobre o tema é pior
 * que amostra nenhuma.
 *
 * ## Rádio nativo, não botão com `aria-checked`
 *
 * `<input type="radio">` já dá navegação por setas, agrupamento por `name` e
 * leitura correta em leitor de tela, sem uma linha de JavaScript. O input fica
 * invisível mas focável (`sr-only` é só posicionamento, nunca `display:none`,
 * que o tiraria da ordem de tabulação), e o card é o `<label>`.
 */
export function AppearanceSection() {
  const preferencia = useThemeStore((estado) => estado.preferencia);
  const temaEfetivo = useThemeStore((estado) => estado.temaEfetivo);
  const escolher = useThemeStore((estado) => estado.escolher);
  const grupo = useId();

  const opcoes = [
    ...TEMAS.map((tema) => ({
      id: tema.id,
      nome: tema.nome,
      descricao: tema.descricao,
      /** O tema que a amostra pinta. */
      amostra: tema.id,
    })),
    {
      id: SEGUIR_O_SISTEMA,
      nome: "Seguir o sistema",
      descricao: "Acompanha o modo claro ou escuro do Windows, e muda junto.",
      // "Seguir o sistema" não tem cor própria — é a ausência de escolha. A
      // amostra mostra o que ele resolveria AGORA, que é a informação útil.
      amostra: temaEfetivo,
    },
  ];

  return (
    <section>
      <p className="text-sm text-ink-muted">
        O tema vale para o app inteiro e acompanha você entre as sessões.
      </p>

      <div role="radiogroup" aria-label="Tema" className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {opcoes.map((opcao) => {
          const selecionada = preferencia === opcao.id;
          return (
            <label
              key={opcao.id}
              className={[
                "group cursor-pointer rounded-lg border p-2 transition-[border-color,background-color] duration-150 ease-out",
                selecionada
                  ? "border-emerald bg-surface-sunken"
                  : "border-border bg-surface hover:border-ink-muted",
              ].join(" ")}
            >
              <input
                type="radio"
                name={grupo}
                value={opcao.id}
                checked={selecionada}
                onChange={() => escolher(opcao.id)}
                className="sr-only"
              />
              <ThemeSwatch tema={opcao.amostra} />
              <span className="mt-2 block text-sm font-medium text-ink">{opcao.nome}</span>
              <span className="mt-0.5 block text-xs text-ink-muted">{opcao.descricao}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

/**
 * O app em miniatura, pintado com os tokens do tema `tema`.
 *
 * Reproduz a estrutura real — barra lateral rebaixada, conteúdo sobre o papel,
 * uma linha de título, duas de texto e um acento — porque é isso que faz a
 * amostra responder à pergunta que o usuário está fazendo ("como vai ficar a
 * minha tela?") em vez de mostrar quadradinhos de cor soltos.
 */
function ThemeSwatch({ tema }: { tema: string }) {
  return (
    <span
      data-theme={tema}
      aria-hidden="true"
      className="flex h-16 w-full overflow-hidden rounded-md border border-border bg-paper"
    >
      <span className="flex w-1/3 flex-col gap-1 bg-surface-sunken p-1.5">
        <span className="h-1.5 w-3/4 rounded-full bg-ink-muted opacity-70" />
        <span className="h-1.5 w-1/2 rounded-full bg-ink-muted opacity-40" />
        <span className="h-1.5 w-2/3 rounded-full bg-ink-muted opacity-40" />
      </span>
      <span className="flex flex-1 flex-col gap-1 p-1.5">
        <span className="h-2 w-2/3 rounded-full bg-ink opacity-80" />
        <span className="h-1.5 w-full rounded-full bg-ink-muted opacity-50" />
        <span className="h-1.5 w-5/6 rounded-full bg-ink-muted opacity-50" />
        <span className="mt-auto h-2 w-1/3 rounded-sm bg-emerald" />
      </span>
    </span>
  );
}
