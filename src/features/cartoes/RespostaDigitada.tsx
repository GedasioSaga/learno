import { useState, type FormEvent } from "react";
import { compararResposta, type ResultadoDaComparacao } from "./comparar-resposta";

type Props = { esperado: string; revelado: boolean; onEnviar: (acertou: boolean) => void };

/**
 * Classe de cada pedaço do diff. Cor sozinha nunca comunica o status: "sobrando"
 * e "errado" também vêm riscados (`line-through`), "faltando" também sublinhado
 * (`underline`) — quem não distingue as duas cores ainda lê a diferença.
 */
function classePorStatus(status: ResultadoDaComparacao["pedacos"][number]["status"]): string {
  switch (status) {
    case "certo":
      return "text-ink";
    case "faltando":
      return "text-ink-muted underline underline-offset-2";
    case "errado":
    case "sobrando":
      return "text-terracotta-ink line-through";
  }
}

/**
 * O cartão do tipo "Digitar a resposta": campo de texto até o pai revelar,
 * diff caractere a caractere depois. Quem decide revelar é o pai (props
 * `revelado`) — este componente só reage, nunca chama `onEnviar` de novo
 * depois de revelado nem esconde o diff por conta própria.
 */
export function RespostaDigitada({ esperado, revelado, onEnviar }: Props) {
  const [digitado, setDigitado] = useState("");

  function conferir() {
    onEnviar(compararResposta(esperado, digitado).acertou);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    conferir();
  }

  if (revelado) {
    const { pedacos } = compararResposta(esperado, digitado);
    return (
      <div role="status" className="flex flex-col gap-2">
        <p className="text-base">
          {pedacos.map((pedaco, indice) => (
            // Índice é chave estável aqui: `pedacos` é recalculado por render a
            // partir de `esperado`/`digitado` fixos, nunca reordenado nem editado
            // em lista viva.
            <span key={indice} className={classePorStatus(pedaco.status)}>
              {pedaco.texto}
            </span>
          ))}
        </p>
        <p className="text-sm text-ink-muted">Resposta: {esperado}</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <label className="flex-1 text-sm">
        <span className="mb-1 block text-ink-muted">Sua resposta</span>
        <input
          type="text"
          value={digitado}
          onChange={(event) => setDigitado(event.currentTarget.value)}
          className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-ink"
        />
      </label>
      <button
        type="submit"
        className="self-end rounded-sm bg-emerald px-4 py-2 text-sm text-on-emerald"
      >
        Conferir
      </button>
    </form>
  );
}
