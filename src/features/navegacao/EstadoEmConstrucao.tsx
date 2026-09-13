import { useId, type ReactNode } from "react";

interface EstadoEmConstrucaoProps {
  /** O nome do que está sendo construído: uma seção ("Trilha") ou um pedaço dela ("Previsão de revisões"). */
  nome: string;
  /** O que isto vai ser, em uma ou duas frases. Prosa, não promessa de prazo. */
  descricao: string;
  /** O que está combinado, um item por linha. Lista vazia esconde o bloco. */
  planejado?: readonly string[];
  /** SVG em `currentColor`; sai em âmbar dentro de um selo de controle. */
  icone?: ReactNode;
}

/**
 * O estado honesto de uma tela que ainda não existe.
 *
 * Substitui a tentação de mostrar uma maquete: um gráfico de mentira, um
 * contador zerado que parece dado real, uma lista de exemplo. Quem abre a
 * seção precisa saber três coisas — o que vai ter aqui, que ainda não está
 * pronto, e que nada do que vê é dado seu. As três estão no texto, não na
 * decoração.
 *
 * Reutilizável de propósito: uma seção pronta usa o mesmo componente para o
 * pedaço dela que ainda não chegou (o painel de previsão dentro de Cartões,
 * por exemplo), assim "em construção" tem uma cara só no app inteiro.
 *
 * A largura de leitura segue `--measure` (§4 do DESIGN-TOKENS): é prosa.
 */
export function EstadoEmConstrucao({ nome, descricao, planejado = [], icone }: EstadoEmConstrucaoProps) {
  // Único por instância: mais de um `EstadoEmConstrucao` pode aparecer na
  // mesma tela (hoje é só a Trilha dentro da seção Hoje; o app já teve dois
  // lado a lado antes de Cronograma ganhar seção própria, e pode voltar a
  // ter quando outra seção parcial reaproveitar este componente) — um id
  // fixo faria duas instâncias colidirem no DOM (HTML inválido) e o
  // `aria-labelledby` da segunda resolver para o título da primeira.
  const tituloId = useId();

  return (
    <section
      aria-labelledby={tituloId}
      className="flex h-full items-center justify-center overflow-y-auto px-8 py-8"
    >
      <div className="w-full" style={{ maxWidth: "var(--measure)" }}>
        {icone ? (
          <div className="mb-6 grid size-14 place-items-center rounded-md border border-border bg-surface text-amber shadow-hard-sm [&>svg]:size-7">
            {icone}
          </div>
        ) : null}

        <span className="inline-flex items-center gap-1.5 rounded-sm bg-amber/10 px-2 py-0.5 text-xs font-medium text-amber-ink">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" />
          Em construção
        </span>

        <h2 id={tituloId} className="mt-3 font-display text-2xl leading-tight text-ink">
          {nome}
        </h2>
        <p className="mt-2 text-base text-ink-muted">{descricao}</p>

        {planejado.length > 0 ? (
          <>
            <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              O que está planejado
            </h3>
            <ul className="mt-2 space-y-2">
              {planejado.map((item) => (
                <li key={item} className="flex gap-3 text-sm text-ink">
                  <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-border" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <p className="mt-6 border-t border-hairline pt-4 text-xs text-ink-muted">
          Nada nesta tela é dado seu ainda. Quando a seção ficar pronta, ela aparece no lugar deste aviso.
        </p>
      </div>
    </section>
  );
}
