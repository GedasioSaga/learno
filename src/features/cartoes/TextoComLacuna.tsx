import type { ClozeSegment } from "../../lib/ipc";

type Props = {
  /** Vem pronto do backend (`CardToStudy.cloze`) — esta tela não interpreta `{{...}}`. */
  segmentos: ClozeSegment[];
  /** `card.templateOrdinal` de um cartão cloze: só aparece na mensagem de nota quebrada. */
  numeroDaLacuna: number;
  revelado: boolean;
  /** O campo "Extra" (convenção "Back Extra" do Anki): só entra depois de revelar, e só se tiver texto. */
  extra: string;
};

/** Texto que o leitor de voz lê no lugar de uma lacuna sem dica. */
const LACUNA_FALADA = "lacuna";
/** O que a tela mostra dentro de uma lacuna sem dica. */
export const LACUNA_VAZIA = "…";

/**
 * A receita visual de uma lacuna, exportada para `CriarLacunaDeOrigem`
 * desenhar a prévia com a MESMA peça: criar e estudar precisam ter a mesma
 * cara, senão o usuário aprende duas linguagens para um conceito só. O
 * porquê de cada token está no comentário de `TextoComLacuna` abaixo.
 */
export const CLASSE_LACUNA_ESCONDIDA =
  "mx-0.5 inline-block min-w-12 rounded-sm border-b-2 border-amber bg-amber/10 px-1.5 text-center text-amber-ink";
export const CLASSE_LACUNA_REVELADA = "border-b-2 border-amber font-medium text-amber-ink";

/**
 * O texto de um cartão cloze como uma frase só, para o `LeitorDeVoz`:
 * antes de revelar, cada lacuna vira a dica (ou a palavra "lacuna"); depois,
 * o texto completo. Puro, e a única outra leitura dos segmentos além do
 * componente — se um dia a fala e a tela discordarem sobre o que está
 * escondido, o defeito está aqui ou ali, nunca num terceiro lugar.
 */
export function textoDaLacunaParaVoz(segmentos: ClozeSegment[], revelado: boolean): string {
  return segmentos
    .map((segmento) => {
      if (!segmento.hidden || revelado) return segmento.text;
      return segmento.hint ?? LACUNA_FALADA;
    })
    .join("");
}

/**
 * O texto de um cartão cloze com a lacuna deste cartão escondida (frente) ou
 * preenchida no mesmo lugar (verso).
 *
 * Nada aqui anima, de propósito: revelar é a ação mais frequente da sessão
 * e, pelo espaço, iniciada por teclado — os dois casos em que a régua de
 * movimento (`docs/DESIGN-TOKENS.md` §9) manda não animar. O que faz a
 * revelação ser legível é a POSIÇÃO: a resposta nasce exatamente onde a
 * lacuna estava, com a mesma linha de base âmbar, então o olho não precisa
 * procurar nada.
 *
 * A lacuna é a única coisa em destaque na tela, e usa a família âmbar porque
 * é a única cujo par `-ink`/`surface` passa de 4.5:1 nos cinco temas E cuja
 * cor pura (a linha de base) passa de 3:1 em todos — inclusive no Alto
 * contraste, onde `bg-amber/10` quase some e é a borda que segura o
 * destaque. Nunca só cor: a lacuna tem borda, fundo e um rótulo para leitor
 * de tela; a resposta revelada tem borda e peso.
 *
 * O texto escondido NÃO entra no DOM antes de `revelado` — é a garantia nº 1
 * de `EstudoSessao`, e vale aqui do mesmo jeito: `segmento.text` de uma
 * lacuna só é renderizado no ramo revelado.
 */
export function TextoComLacuna({ segmentos, numeroDaLacuna, revelado, extra }: Props) {
  const temLacuna = segmentos.some((segmento) => segmento.hidden);
  const temTexto = segmentos.some((segmento) => segmento.text !== "" || segmento.hidden);

  return (
    <div className="mx-auto max-w-[var(--measure)] text-left">
      {temTexto ? (
        <p className="whitespace-pre-wrap text-lg leading-relaxed text-ink">
          {segmentos.map((segmento, indice) => {
            // Índice como chave é estável: a lista vem inteira do backend
            // por cartão e nunca é reordenada nem editada em lista viva.
            if (!segmento.hidden) return <span key={indice}>{segmento.text}</span>;

            if (revelado) {
              return (
                <span key={indice} className={CLASSE_LACUNA_REVELADA}>
                  {segmento.text}
                </span>
              );
            }

            return (
              <span key={indice} className={CLASSE_LACUNA_ESCONDIDA}>
                <span className="sr-only">{segmento.hint ? "lacuna, dica: " : "lacuna"}</span>
                {segmento.hint ? <span className="italic">{segmento.hint}</span> : <span aria-hidden="true">{LACUNA_VAZIA}</span>}
              </span>
            );
          })}
        </p>
      ) : (
        <p className="text-center text-lg text-ink-muted">(sem conteúdo)</p>
      )}

      {!temLacuna && temTexto ? (
        // Nota editada depois de o cartão nascer, ou marcação quebrada: o
        // cartão aponta para uma lacuna que o texto não tem mais. O usuário
        // vê o texto inteiro, sabe por quê, e os botões continuam — perde o
        // cartão, não a sessão.
        <p role="status" className="mt-3 text-sm text-ink-muted">
          Este cartão é da lacuna {numeroDaLacuna}, mas o texto não tem mais essa lacuna. Responda para seguir e edite a nota
          para corrigir.
        </p>
      ) : null}

      {revelado && extra.trim() !== "" ? (
        <div className="mt-6 border-t border-hairline pt-6">
          <p className="text-xs uppercase tracking-wide text-ink-muted">Extra</p>
          <p className="whitespace-pre-wrap text-base text-ink">{extra}</p>
        </div>
      ) : null}
    </div>
  );
}
