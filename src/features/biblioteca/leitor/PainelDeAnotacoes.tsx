import type { Anotacao, FormatoDeLivro } from "../../../lib/ipc";

interface PainelDeAnotacoesProps {
  formato: FormatoDeLivro;
  anotacoes: Anotacao[];
  carregando: boolean;
  erro: string | null;
  onIrPara: (anotacao: Anotacao) => void;
}

/**
 * O vocabulário de `locatorStart` depende do formato do livro (ponto 2 do
 * contrato) — a etiqueta acompanha. Exportado: `LeitorDeLivro` reusa a mesma
 * etiqueta na procedência textual de um cartão criado a partir de um trecho
 * selecionado (ver comentário de `OrigemDoCartao` em
 * `src/features/cartoes/CriarCartaoDeOrigem.tsx`) — mesmo rótulo, um lugar
 * só, em vez de duas listas hardcoded que podem divergir.
 */
export const ROTULO_DO_LOCATOR: Record<FormatoDeLivro, string> = {
  pdf: "Página",
  epub: "Posição",
};

/** As três cores de destaque do app (mesma paleta de marca de `LivroCard`/tokens) — nunca um hex livre digitado na hora de criar a anotação. */
const CLASSE_DA_COR: Record<string, string> = {
  amber: "bg-amber",
  mint: "bg-mint",
  terracotta: "bg-terracotta",
};

/**
 * A lista de anotações do livro aberto, comum aos dois formatos — pula para
 * qualquer uma delas ao clicar. Quem resolve "pular" de fato é a casca
 * (`LeitorDeLivro`), que sabe traduzir `locatorStart` na chamada certa do
 * `ref` do formato ativo; este painel só lista e avisa qual foi escolhida.
 */
export function PainelDeAnotacoes({ formato, anotacoes, carregando, erro, onIrPara }: PainelDeAnotacoesProps) {
  const rotuloDoLocator = ROTULO_DO_LOCATOR[formato];

  if (carregando) {
    return <p className="px-3 py-3 text-xs text-ink-muted">Carregando anotações…</p>;
  }

  if (erro) {
    return (
      <p role="alert" className="px-3 py-3 text-xs text-terracotta-ink">
        {erro}
      </p>
    );
  }

  if (anotacoes.length === 0) {
    return (
      <p className="px-3 py-3 text-xs text-ink-muted">
        Nenhuma anotação ainda. Selecione um trecho de texto na leitura para grifar.
      </p>
    );
  }

  return (
    <ul aria-label="Anotações" className="flex flex-col gap-0.5 overflow-y-auto px-2 py-2">
      {anotacoes.map((anotacao) => (
        <li key={anotacao.id}>
          <button
            type="button"
            onClick={() => onIrPara(anotacao)}
            className="flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left transition-transform motion-reduce:transition-none hover:bg-surface-sunken active:scale-97"
          >
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${anotacao.color ? (CLASSE_DA_COR[anotacao.color] ?? "bg-border") : "bg-border"}`}
              />
              <span className="text-xs text-ink-muted">
                {rotuloDoLocator} {anotacao.locatorStart}
              </span>
            </span>
            <span className="line-clamp-2 text-sm text-ink">“{anotacao.excerpt}”</span>
            {anotacao.note ? <span className="line-clamp-2 text-xs text-ink-muted">{anotacao.note}</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
