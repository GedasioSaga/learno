import { useEffect } from "react";
import { IconeBiblioteca } from "../navegacao/icones";
import { agruparEstantePorCategoria, filtrarLivros, filtrarPorCategoria } from "./filtro";
import { GradeDeLivros } from "./GradeDeLivros";
import { ImportarLivroButton } from "./ImportarLivroButton";
import { LeitorDeLivro } from "./leitor/LeitorDeLivro";
import { useBibliotecaStore } from "./store";

/**
 * O conteúdo principal da seção Biblioteca: a estante (grade de livros com
 * progresso) por padrão, ou o placeholder honesto de leitura quando um
 * livro é aberto — mesma forma de `ConteudoDeCartoes` (loading/error/tela),
 * com "estante"/"leitura" no lugar de "resumo"/"estudo"/"criar".
 *
 * Chama `load()` de novo, igual a `ConteudoDeCartoes`: a guarda em
 * `store.load` contra chamadas concorrentes cobre painel e conteúdo
 * montando juntos sem duplicar a rodada de rede.
 */
export function ConteudoDeBiblioteca() {
  const status = useBibliotecaStore((state) => state.status);
  const errorMessage = useBibliotecaStore((state) => state.errorMessage);
  const load = useBibliotecaStore((state) => state.load);
  const livros = useBibliotecaStore((state) => state.livros);
  const filtro = useBibliotecaStore((state) => state.filtro);
  const categoriasPorLivro = useBibliotecaStore((state) => state.categoriasPorLivro);
  const categorias = useBibliotecaStore((state) => state.categorias);
  const filtroCategoriaId = useBibliotecaStore((state) => state.filtroCategoriaId);
  const tela = useBibliotecaStore((state) => state.tela);
  const livroSelecionadoId = useBibliotecaStore((state) => state.livroSelecionadoId);
  const abrirLeitura = useBibliotecaStore((state) => state.abrirLeitura);
  const voltarParaEstante = useBibliotecaStore((state) => state.voltarParaEstante);
  const remover = useBibliotecaStore((state) => state.remover);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading" || status === "idle") {
    return <p className="p-6 text-sm text-ink-muted">Carregando a estante…</p>;
  }

  if (status === "error") {
    return (
      <p role="alert" className="p-6 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar a biblioteca."}
      </p>
    );
  }

  if (tela === "leitura" && livroSelecionadoId) {
    // `key` força uma instância nova por livro: sem isto, abrir "B" logo
    // depois de "A" reaproveitaria o estado (página, zoom, anotações) da
    // instância de "A" em vez de recarregar do zero.
    return <LeitorDeLivro key={livroSelecionadoId} livroId={livroSelecionadoId} onVoltar={voltarParaEstante} />;
  }

  if (livros.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 py-8">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 grid size-14 place-items-center rounded-md border border-border bg-surface text-amber shadow-hard-sm [&>svg]:size-7">
            <IconeBiblioteca />
          </div>
          <h2 className="font-display text-xl text-ink">A estante está vazia</h2>
          <p className="mt-2 text-sm text-ink-muted">
            Traga um PDF ou um EPUB para começar. Assim que importar, ele aparece aqui com uma barra
            marcando quanto você já leu.
          </p>
          <div className="mt-5">
            <ImportarLivroButton variante="destaque" />
          </div>
        </div>
      </div>
    );
  }

  // Os dois filtros são independentes (status e categoria) e se compõem por
  // "E": status primeiro, categoria depois — a ordem não muda o resultado
  // (os dois são filtros de conjunto), só a legibilidade de qual roda antes.
  // D1: `categorias` entra para `filtrarPorCategoria` alcançar os
  // descendentes de `filtroCategoriaId`, não só a correspondência direta.
  const livrosFiltrados = filtrarPorCategoria(
    filtrarLivros(livros, filtro),
    filtroCategoriaId,
    categoriasPorLivro,
    categorias,
  );

  if (livrosFiltrados.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 py-8">
        <p className="text-sm text-ink-muted">Nenhum livro nesse filtro.</p>
      </div>
    );
  }

  // D: com um filtro de categoria ESPECÍFICO já ativo no painel lateral, o
  // agrupamento por categoria/subcategoria fica DESLIGADO — os dois eixos
  // (o filtro e o agrupamento) são o MESMO eixo (categoria), e um livro pode
  // ter uma SEGUNDA categoria sem nenhuma relação com a que filtrou a
  // estante; agrupar por ela aqui vazaria um cabeçalho estranho ("por que
  // 'Não-ficção' apareceu, eu filtrei por 'Fantasia'?"). "Todas as
  // categorias" (`filtroCategoriaId === null`) é o único estado em que
  // agrupar tem uma resposta óbvia para "agrupar por quê". `estante` só
  // existe quando o agrupamento está ligado; sem categoria nenhuma criada
  // ainda (`grupos.length === 0`) a estante também cai na grade lisa — um
  // único cabeçalho fantasma não ajudaria ninguém.
  const estante = filtroCategoriaId === null ? agruparEstantePorCategoria(livrosFiltrados, categorias, categoriasPorLivro) : null;

  if (estante && estante.grupos.length > 0) {
    return (
      <div className="flex flex-col gap-5 p-6">
        {/* ORDEM GLOBAL: ver o comentário de `GradeDeLivros.tsx`. Isto avisa
            na tela o que o código já garante — reordenar dentro de UM grupo
            (os dois "Percy Jackson" de uma mesma subcategoria, por exemplo)
            também reordena a estante inteira, porque só existe uma ordem. */}
        <p className="text-xs text-ink-muted">
          Arraste um livro (ou use as setas ↑/↓ no cartão) para reordenar — a ordem vale para a estante inteira,
          não só para este grupo.
        </p>
        {estante.grupos.map((grupo) => (
          <section key={grupo.raiz.id} aria-labelledby={`estante-categoria-${grupo.raiz.id}`}>
            <h2 id={`estante-categoria-${grupo.raiz.id}`} className="mb-1.5 text-sm font-semibold text-ink">
              {grupo.raiz.name}
            </h2>
            <div className="flex flex-col gap-3">
              {grupo.subgrupos.map((subgrupo) => (
                <div key={subgrupo.subcategoria?.id ?? "_"}>
                  {subgrupo.subcategoria ? (
                    <h3 className="mb-1 pl-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
                      {subgrupo.subcategoria.name}
                    </h3>
                  ) : null}
                  <GradeDeLivros
                    livros={subgrupo.livros}
                    onAbrir={abrirLeitura}
                    onRemover={(livroId) => void remover(livroId)}
                  />
                </div>
              ))}
            </div>
          </section>
        ))}
        {estante.semCategoria.length > 0 ? (
          <section aria-labelledby="estante-sem-categoria">
            <h2 id="estante-sem-categoria" className="mb-1.5 text-sm font-semibold text-ink">
              Sem categoria
            </h2>
            <GradeDeLivros
              livros={estante.semCategoria}
              onAbrir={abrirLeitura}
              onRemover={(livroId) => void remover(livroId)}
            />
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <div className="p-6">
      <GradeDeLivros livros={livrosFiltrados} onAbrir={abrirLeitura} onRemover={(livroId) => void remover(livroId)} />
    </div>
  );
}
