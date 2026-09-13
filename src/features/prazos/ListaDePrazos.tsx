import { useEffect, useState } from "react";
import { listDecks, listPageTree, type DeckRow, type PageRow } from "../../lib/ipc";
import { PrazoCard } from "./PrazoCard";
import { PrazoForm } from "./PrazoForm";
import type { PrazoComContagem, PrazoRow } from "./ipc";
import { usePrazosStore } from "./store";

type Formulario = "fechado" | "criar" | PrazoRow;

/**
 * A tela de Prazos: lista ordenada por proximidade, com vencidos sempre
 * visíveis (nunca escondidos — regra do pedido) e um estado vazio honesto.
 *
 * Não chamada `ConteudoDePrazos` de propósito: `toda-tela-e-alcancavel.test.ts`
 * exige que todo `ConteudoDeX` esteja montado em `App.tsx`, arquivo fora do
 * alcance desta peça (Prazos também não está em `SECAO_IDS` — quem decide
 * como esta tela é alcançada, se por uma seção nova ou outro caminho, é
 * quem monta `App.tsx`).
 */
export function ListaDePrazos() {
  const status = usePrazosStore((state) => state.status);
  const errorMessage = usePrazosStore((state) => state.errorMessage);
  const listagem = usePrazosStore((state) => state.listagem);
  const load = usePrazosStore((state) => state.load);

  const [decks, setDecks] = useState<DeckRow[]>([]);
  const [paginas, setPaginas] = useState<PageRow[]>([]);
  const [formulario, setFormulario] = useState<Formulario>("fechado");

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Só rótulos extras (nome do baralho, título da página) — falhar aqui
    // não pode travar a lista de prazos, que já tem o próprio erro tratado
    // pela store.
    let cancelado = false;
    Promise.all([listDecks(), listPageTree()])
      .then(([listaDeBaralhos, arvoreDePaginas]) => {
        if (cancelado) return;
        setDecks(listaDeBaralhos);
        setPaginas(arvoreDePaginas);
      })
      .catch(() => {
        // Ver o comentário acima: sem os nomes, os cartões só deixam de
        // mostrar "Baralho:"/"Página:" — a lista continua utilizável.
      });
    return () => {
      cancelado = true;
    };
  }, []);

  function nomeDoBaralho(deckId: string | null): string | null {
    if (deckId === null) return null;
    // Retorna `null` também quando o baralho foi movido para a lixeira
    // (`listDecks()` só traz os ativos) — não há como nomear algo que não
    // está na lista, e inventar "(removido)" seria afirmar um estado que
    // ninguém verificou de fato.
    return decks.find((deck) => deck.id === deckId)?.name ?? null;
  }

  function tituloDaPagina(pageId: string | null): string | null {
    if (pageId === null) return null;
    return paginas.find((pagina) => pagina.id === pageId)?.title ?? null;
  }

  if (status === "loading" || status === "idle") {
    return <p className="p-6 text-sm text-ink-muted">Carregando prazos…</p>;
  }

  if (status === "error" || !listagem) {
    return (
      <p role="alert" className="p-6 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar os prazos."}
      </p>
    );
  }

  const semNenhumPrazo = listagem.vencidos.length === 0 && listagem.futuros.length === 0;

  function renderLista(prazos: PrazoComContagem[]) {
    return (
      <ul className="flex flex-col gap-2">
        {prazos.map((prazo) => (
          <PrazoCard
            key={prazo.id}
            prazo={prazo}
            nomeDoBaralho={nomeDoBaralho(prazo.deckId)}
            tituloDaPagina={tituloDaPagina(prazo.pageId)}
            onEditar={() => setFormulario(prazo)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl text-ink">Prazos</h1>
        <button
          type="button"
          onClick={() => setFormulario("criar")}
          className="rounded-sm bg-emerald px-3 py-1.5 text-sm font-medium text-on-emerald transition duration-150 ease-out motion-reduce:transition-none hover:brightness-110 active:scale-97"
        >
          + Novo prazo
        </button>
      </div>

      {formulario !== "fechado" ? (
        <PrazoForm prazo={formulario === "criar" ? undefined : formulario} onFechar={() => setFormulario("fechado")} />
      ) : null}

      {semNenhumPrazo ? (
        <p className="text-sm text-ink-muted">
          Nenhum prazo cadastrado ainda. Crie um para começar a contagem regressiva.
        </p>
      ) : (
        <>
          {listagem.vencidos.length > 0 ? (
            <section aria-labelledby="prazos-vencidos-titulo" className="flex flex-col gap-2">
              <h2
                id="prazos-vencidos-titulo"
                className="text-xs font-medium uppercase tracking-wide text-terracotta-ink"
              >
                Vencidos
              </h2>
              {renderLista(listagem.vencidos)}
            </section>
          ) : null}

          {listagem.futuros.length > 0 ? (
            <section aria-labelledby="prazos-futuros-titulo" className="flex flex-col gap-2">
              <h2 id="prazos-futuros-titulo" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                Próximos
              </h2>
              {renderLista(listagem.futuros)}
            </section>
          ) : null}
        </>
      )}

      {/* Erro de uma ação (criar/editar/concluir/apagar) — a lista já
          carregada continua na tela; mesmo padrão de `ConteudoDeCronograma`
          para o erro de uma mutação (diferente do erro de `load()` acima,
          que troca a tela inteira porque aí não há nada confiável a mostrar). */}
      {errorMessage && status === "ready" ? (
        <p role="alert" className="text-sm text-terracotta-ink">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
