import { describe, expect, it } from "vitest";
import type { Categoria, CategoriasDoLivro, LivroNaEstante } from "../../lib/ipc";
import {
  agruparEstantePorCategoria,
  buildCategoriaChildrenIndex,
  categoriaMoveTargets,
  categoriaSelfAndDescendantIds,
  contarPorStatus,
  filtrarLivros,
  filtrarPorCategoria,
  flattenVisibleCategoriaTree,
  getCategoriaDescendantIds,
  indexarCategoriasPorLivro,
} from "./filtro";

function livro(overrides: Partial<LivroNaEstante["progresso"]> & Pick<LivroNaEstante["progresso"], "status">): LivroNaEstante {
  return {
    livro: {
      id: overrides.status,
      pageId: "00000000-0000-0000-0000-000000000001",
      format: "pdf",
      fileName: "arquivo.pdf",
      coverFileName: null,
      totalUnits: 100,
      contentHash: "sha-teste",
      originalFileName: "original.pdf",
      fileSize: 1024,
      metadataTitle: null,
      metadataAuthor: null,
      hasTextLayer: true,
      // Índice fracionário da ORDEM da estante — contrato chegou em
      // `lib/ipc.ts` durante esta peça; valor fixo porque nenhum teste deste
      // arquivo (filtro/agrupamento) depende de ordem entre livros.
      position: "a0",
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:00:00.000Z",
    },
    progresso: {
      bookId: "00000000-0000-0000-0000-000000000000",
      currentLocator: "0",
      currentFraction: 0,
      furthestLocator: "0",
      furthestFraction: 0,
      finishedAt: null,
      updatedAt: "2026-09-05T10:00:00.000Z",
      lastReadAt: null,
      ...overrides,
    },
    titulo: `Livro ${overrides.status}`,
    autor: null,
  };
}

/** `livro()` acima chaveia por `status` (as suítes existentes já fazem isso); aqui cada teste de agrupamento precisa de vários livros de IDS distintos, então este helper monta um `LivroNaEstante` com id/título próprios. */
function livroComId(id: string, titulo: string): LivroNaEstante {
  return { ...livro({ status: "unread" }), livro: { ...livro({ status: "unread" }).livro, id }, titulo };
}

describe("filtrarLivros", () => {
  it("'todos' devolve a estante inteira, sem olhar o status", () => {
    const livros = [livro({ status: "unread" }), livro({ status: "reading" }), livro({ status: "finished" })];
    expect(filtrarLivros(livros, "todos")).toHaveLength(3);
  });

  it("filtra por progresso.status, não por qualquer outra ideia de 'em andamento'", () => {
    const naoLido = livro({ status: "unread" });
    const lendo = livro({ status: "reading" });
    const lido = livro({ status: "finished" });
    const livros = [naoLido, lendo, lido];

    expect(filtrarLivros(livros, "reading")).toEqual([lendo]);
    expect(filtrarLivros(livros, "finished")).toEqual([lido]);
    expect(filtrarLivros(livros, "unread")).toEqual([naoLido]);
  });

  it("lista vazia continua vazia em qualquer filtro", () => {
    expect(filtrarLivros([], "todos")).toEqual([]);
    expect(filtrarLivros([], "reading")).toEqual([]);
  });
});

// `parentId` ainda não existe em `Categoria` (`lib/ipc.ts`) nesta rodada —
// contrato é de quem escreve aquele arquivo, ver relatório desta tarefa.
// `tsc` falha SÓ nesta linha ("object literal may only specify known
// properties") até o contrato chegar; escrito assim de propósito, do mesmo
// jeito que o resto do código desta peça escreve contra o contrato final.
function categoria(id: string, name: string, parentId: string | null = null): Categoria {
  return { id, name, parentId, position: "a0", createdAt: "2026-09-05T10:00:00.000Z", updatedAt: "2026-09-05T10:00:00.000Z" };
}

describe("indexarCategoriasPorLivro", () => {
  it("indexa cada linha de CategoriasDoLivro pelo livroId", () => {
    const ficcao = categoria("cat-ficcao", "Ficção");
    const linhas: CategoriasDoLivro[] = [{ livroId: "a", categorias: [ficcao] }];

    const mapa = indexarCategoriasPorLivro(linhas);

    expect(mapa.get("a")).toEqual([ficcao]);
    expect(mapa.get("b")).toBeUndefined();
  });
});

describe("filtrarPorCategoria", () => {
  it("mostra só os livros daquela categoria", () => {
    const ficcao = categoria("cat-ficcao", "Ficção");
    const comFiccao = livro({ status: "reading" });
    const semFiccao = livro({ status: "unread" });
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: comFiccao.livro.id, categorias: [ficcao] }]);

    const resultado = filtrarPorCategoria([comFiccao, semFiccao], "cat-ficcao", categoriasPorLivro);

    expect(resultado).toEqual([comFiccao]);
  });

  it("`categoriaId: null` ('todas as categorias') devolve a estante inteira — um livro sem categoria nenhuma não some", () => {
    const semCategoriaNenhuma = livro({ status: "unread" });
    const categoriasPorLivro = indexarCategoriasPorLivro([]);

    const resultado = filtrarPorCategoria([semCategoriaNenhuma], null, categoriasPorLivro);

    expect(resultado).toEqual([semCategoriaNenhuma]);
  });

  it("livro sem categoria nenhuma some de um filtro de categoria específica, mas não de 'todas'", () => {
    const ficcao = categoria("cat-ficcao", "Ficção");
    const comFiccao = livro({ status: "reading" });
    const semCategoriaNenhuma = livro({ status: "unread" });
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: comFiccao.livro.id, categorias: [ficcao] }]);
    const livros = [comFiccao, semCategoriaNenhuma];

    expect(filtrarPorCategoria(livros, "cat-ficcao", categoriasPorLivro)).toEqual([comFiccao]);
    expect(filtrarPorCategoria(livros, null, categoriasPorLivro)).toEqual(livros);
  });

  it("D1: filtrar pelo avô mostra o livro que só está no neto (categoria assinada só na folha mais funda)", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const alta = categoria("cat-alta", "Alta Fantasia", "cat-epico");
    const categorias = [fantasia, epico, alta];

    // O livro só tem a categoria mais funda (o neto de "Fantasia") — nenhuma
    // categoria intermediária foi atribuída a ele.
    const soNoNeto = livro({ status: "unread" });
    const foraDaArvore = livro({ status: "reading" });
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: soNoNeto.livro.id, categorias: [alta] }]);
    const livros = [soNoNeto, foraDaArvore];

    const resultado = filtrarPorCategoria(livros, "cat-fantasia", categoriasPorLivro, categorias);

    expect(resultado).toEqual([soNoNeto]);
  });

  it("sem `categorias` (parâmetro omitido), o filtro cai de volta em só a correspondência direta — não alcança descendentes", () => {
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const soNoFilho = livro({ status: "unread" });
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: soNoFilho.livro.id, categorias: [epico] }]);

    const resultado = filtrarPorCategoria([soNoFilho], "cat-fantasia", categoriasPorLivro);

    expect(resultado).toEqual([]);
  });
});

describe("buildCategoriaChildrenIndex", () => {
  it("agrupa por parentId, cada grupo ordenado por position, com null como a lista de raízes", () => {
    const fantasia = { ...categoria("cat-fantasia", "Fantasia", null), position: "a1" };
    const poesia = { ...categoria("cat-poesia", "Poesia", null), position: "a0" };
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const categorias = [fantasia, poesia, epico];

    const index = buildCategoriaChildrenIndex(categorias);

    expect(index.get(null)).toEqual([poesia, fantasia]);
    expect(index.get("cat-fantasia")).toEqual([epico]);
    expect(index.get("cat-poesia")).toBeUndefined();
  });
});

describe("getCategoriaDescendantIds", () => {
  it("alcança neto e bisneto, não só filho direto", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const alta = categoria("cat-alta", "Alta Fantasia", "cat-epico");
    const index = buildCategoriaChildrenIndex([fantasia, epico, alta]);

    const descendentes = getCategoriaDescendantIds("cat-fantasia", index);

    expect(descendentes).toEqual(new Set(["cat-epico", "cat-alta"]));
  });

  it("folha sem filhos não tem descendente nenhum", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const index = buildCategoriaChildrenIndex([fantasia]);

    expect(getCategoriaDescendantIds("cat-fantasia", index)).toEqual(new Set());
  });
});

describe("categoriaSelfAndDescendantIds", () => {
  it("inclui o próprio id e todo descendente — usado por store.removerCategoria para saber se um filtro mais fundo fica órfão", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const outraRaiz = categoria("cat-poesia", "Poesia", null);

    const ids = categoriaSelfAndDescendantIds("cat-fantasia", [fantasia, epico, outraRaiz]);

    expect(ids).toEqual(new Set(["cat-fantasia", "cat-epico"]));
    expect(ids.has("cat-poesia")).toBe(false);
  });
});

describe("flattenVisibleCategoriaTree", () => {
  it("árvore de três níveis expandida (collapsedIds vazio) achata todo mundo em ordem, com a profundidade certa", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const alta = categoria("cat-alta", "Alta Fantasia", "cat-epico");
    const index = buildCategoriaChildrenIndex([fantasia, epico, alta]);

    const nos = flattenVisibleCategoriaTree(index, new Set());

    expect(nos.map((n) => [n.categoria.id, n.depth, n.hasChildren])).toEqual([
      ["cat-fantasia", 0, true],
      ["cat-epico", 1, true],
      ["cat-alta", 2, false],
    ]);
  });

  it("recolher o pai remove a subárvore inteira (neto incluso) da lista visível, sem afetar outra raiz", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const alta = categoria("cat-alta", "Alta Fantasia", "cat-epico");
    const poesia = categoria("cat-poesia", "Poesia", null);
    const index = buildCategoriaChildrenIndex([fantasia, epico, alta, poesia]);

    const nos = flattenVisibleCategoriaTree(index, new Set(["cat-fantasia"]));

    expect(nos.map((n) => n.categoria.id)).toEqual(["cat-fantasia", "cat-poesia"]);
  });
});

describe("categoriaMoveTargets", () => {
  it("exclui a própria categoria e todo descendente dela — mover para lá criaria um ciclo", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const alta = categoria("cat-alta", "Alta Fantasia", "cat-epico");
    const poesia = categoria("cat-poesia", "Poesia", null);
    const categorias = [fantasia, epico, alta, poesia];

    const alvos = categoriaMoveTargets("cat-fantasia", categorias);

    expect(alvos.map((n) => n.categoria.id)).toEqual(["cat-poesia"]);
  });
});

describe("contarPorStatus", () => {
  it("conta cada status e 'todos' como o total", () => {
    const livros = [livro({ status: "unread" }), livro({ status: "reading" }), livro({ status: "reading" }), livro({ status: "finished" })];

    expect(contarPorStatus(livros)).toEqual({ todos: 4, unread: 1, reading: 2, finished: 1 });
  });

  it("estante vazia conta zero em tudo", () => {
    expect(contarPorStatus([])).toEqual({ todos: 0, unread: 0, reading: 0, finished: 0 });
  });
});

describe("agruparEstantePorCategoria", () => {
  it("1. livro em DUAS categorias-raiz aparece nos DOIS grupos — nunca só no primeiro", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const poesia = categoria("cat-poesia", "Poesia", null);
    const livroDuplo = livroComId("dois-mundos", "Livro em dois mundos");
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: "dois-mundos", categorias: [fantasia, poesia] }]);

    const estante = agruparEstantePorCategoria([livroDuplo], [fantasia, poesia], categoriasPorLivro);

    expect(estante.grupos).toHaveLength(2);
    const raizes = estante.grupos.map((grupo) => grupo.raiz.name).sort();
    expect(raizes).toEqual(["Fantasia", "Poesia"]);
    for (const grupo of estante.grupos) {
      expect(grupo.subgrupos.flatMap((subgrupo) => subgrupo.livros.map((item) => item.livro.id))).toEqual(["dois-mundos"]);
    }
  });

  it("2. livro SEM NENHUMA categoria não some — vai para `semCategoria`", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const comCategoria = livroComId("com-cat", "Com categoria");
    const semCategoriaNenhuma = livroComId("sem-cat", "Sem categoria nenhuma");
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: "com-cat", categorias: [fantasia] }]);

    const estante = agruparEstantePorCategoria([comCategoria, semCategoriaNenhuma], [fantasia], categoriasPorLivro);

    expect(estante.semCategoria.map((item) => item.livro.id)).toEqual(["sem-cat"]);
    expect(estante.grupos[0].subgrupos.flatMap((s) => s.livros.map((i) => i.livro.id))).toEqual(["com-cat"]);
  });

  it("3. livro atribuído ao PAI (a raiz) e a um FILHO dela aparece nos DOIS grupos (a raiz E a subcategoria)", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const livroNosDois = livroComId("pai-e-filho", "No pai e no filho");
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: "pai-e-filho", categorias: [fantasia, epico] }]);

    const estante = agruparEstantePorCategoria([livroNosDois], [fantasia, epico], categoriasPorLivro);

    expect(estante.grupos).toHaveLength(1);
    const subgrupos = estante.grupos[0].subgrupos;
    // Um balde "sem subcategoria" (a atribuição direta à raiz) e outro "Épico".
    expect(subgrupos.map((s) => s.subcategoria?.name ?? null)).toEqual([null, "Épico"]);
    for (const subgrupo of subgrupos) {
      expect(subgrupo.livros.map((item) => item.livro.id)).toEqual(["pai-e-filho"]);
    }
  });

  it("grupo/subgrupo vazio nunca aparece: uma categoria sem nenhum livro atribuído não vira um cabeçalho fantasma", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const semLivroNenhum = categoria("cat-vazia", "Categoria Vazia", null);
    const comLivro = livroComId("com-livro", "Tem livro");
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: "com-livro", categorias: [fantasia] }]);

    const estante = agruparEstantePorCategoria([comLivro], [fantasia, semLivroNenhum], categoriasPorLivro);

    expect(estante.grupos.map((g) => g.raiz.name)).toEqual(["Fantasia"]);
  });

  it("subgrupo de uma subcategoria sem livro nenhum some, mas o grupo-raiz continua (tem o balde 'sem subcategoria')", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epicoVazio = categoria("cat-epico", "Épico", "cat-fantasia");
    const soNaRaiz = livroComId("so-raiz", "Só na raiz");
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: "so-raiz", categorias: [fantasia] }]);

    const estante = agruparEstantePorCategoria([soNaRaiz], [fantasia, epicoVazio], categoriasPorLivro);

    expect(estante.grupos).toHaveLength(1);
    expect(estante.grupos[0].subgrupos).toHaveLength(1);
    expect(estante.grupos[0].subgrupos[0].subcategoria).toBeNull();
  });

  it("4. neto (categoria mais funda que subcategoria) cai no balde do ANCESTRAL de profundidade 1, não vira um terceiro nível de cabeçalho", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const altaFantasia = categoria("cat-alta", "Alta Fantasia", "cat-epico");
    const soNoNeto = livroComId("so-neto", "Só no neto");
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: "so-neto", categorias: [altaFantasia] }]);

    const estante = agruparEstantePorCategoria([soNoNeto], [fantasia, epico, altaFantasia], categoriasPorLivro);

    expect(estante.grupos).toHaveLength(1);
    expect(estante.grupos[0].subgrupos).toEqual([{ subcategoria: epico, livros: [soNoNeto] }]);
  });

  it("mesma atribuição alcançada por dois ancestrais diferentes não duplica o cartão no MESMO balde (livro em Épico e num neto de Épico)", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const epico = categoria("cat-epico", "Épico", "cat-fantasia");
    const altaFantasia = categoria("cat-alta", "Alta Fantasia", "cat-epico");
    const item = livroComId("livro-1", "Livro");
    // Atribuído tanto a "Épico" quanto ao NETO de "Épico" — os dois mapeiam
    // para o MESMO balde (raiz Fantasia, subcategoria Épico).
    const categoriasPorLivro = indexarCategoriasPorLivro([{ livroId: "livro-1", categorias: [epico, altaFantasia] }]);

    const estante = agruparEstantePorCategoria([item], [fantasia, epico, altaFantasia], categoriasPorLivro);

    expect(estante.grupos).toHaveLength(1);
    expect(estante.grupos[0].subgrupos).toHaveLength(1);
    expect(estante.grupos[0].subgrupos[0].livros).toEqual([item]);
  });

  it("estante sem categoria nenhuma criada: nenhum grupo, todo mundo em `semCategoria`", () => {
    const item = livroComId("livro-1", "Livro");

    const estante = agruparEstantePorCategoria([item], [], new Map());

    expect(estante.grupos).toEqual([]);
    expect(estante.semCategoria).toEqual([item]);
  });

  it("preserva a ordem de `livros` dentro de cada balde (a mesma ordem por `position` que o backend já devolveu)", () => {
    const fantasia = categoria("cat-fantasia", "Fantasia", null);
    const primeiro = livroComId("a", "Primeiro");
    const segundo = livroComId("b", "Segundo");
    const categoriasPorLivro = indexarCategoriasPorLivro([
      { livroId: "a", categorias: [fantasia] },
      { livroId: "b", categorias: [fantasia] },
    ]);

    const estante = agruparEstantePorCategoria([primeiro, segundo], [fantasia], categoriasPorLivro);

    expect(estante.grupos[0].subgrupos[0].livros.map((item) => item.livro.id)).toEqual(["a", "b"]);
  });
});
