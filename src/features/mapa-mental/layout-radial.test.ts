import { describe, expect, it } from "vitest";
import { DISTANCIA_MINIMA_NOS, DISTANCIA_MINIMA_NOS_COM_IMAGEM, layoutRadial } from "./layout-radial";
import type { ArestaDoMapa, NoDoMapa } from "./store";

function no(id: string): NoDoMapa {
  return { id, type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: id } };
}

/** Mesmo `no()` acima, com `data.image` preenchido — o cartão fica mais alto
 *  (a miniatura de `CartaoNode.tsx`) e por isso exige mais distância dos
 *  vizinhos; ver `DISTANCIA_MINIMA_NOS_COM_IMAGEM`. */
function noComImagem(id: string): NoDoMapa {
  return { id, type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: id, image: "foto.png" } };
}

function aresta(id: string, source: string, target: string): ArestaDoMapa {
  return { id, source, target };
}

/** Menor distância euclidiana entre qualquer par de posições devolvidas. */
function menorDistanciaEntrePares(posicoes: Map<string, { x: number; y: number }>): number {
  const pontos = [...posicoes.values()];
  let menor = Infinity;
  for (let i = 0; i < pontos.length; i++) {
    for (let j = i + 1; j < pontos.length; j++) {
      const distancia = Math.hypot(pontos[j].x - pontos[i].x, pontos[j].y - pontos[i].y);
      menor = Math.min(menor, distancia);
    }
  }
  return menor;
}

describe("layoutRadial", () => {
  it("mapa vazio devolve mapa de posições vazio, sem quebrar", () => {
    expect(layoutRadial([], [])).toEqual(new Map());
  });

  it("um nó só recebe uma posição definida (não fica em NaN/undefined)", () => {
    const posicoes = layoutRadial([no("raiz")], []);

    expect(posicoes.size).toBe(1);
    const posicao = posicoes.get("raiz");
    expect(posicao).toBeDefined();
    expect(Number.isFinite(posicao?.x)).toBe(true);
    expect(Number.isFinite(posicao?.y)).toBe(true);
  });

  it("toda árvore devolve exatamente uma posição por nó de entrada", () => {
    const nos = [no("raiz"), no("a"), no("b"), no("a1"), no("a2")];
    const arestas = [aresta("e1", "raiz", "a"), aresta("e2", "raiz", "b"), aresta("e3", "a", "a1"), aresta("e4", "a", "a2")];

    const posicoes = layoutRadial(nos, arestas);

    expect([...posicoes.keys()].sort()).toEqual(["a", "a1", "a2", "b", "raiz"]);
  });

  it("árvore balanceada: nenhum par de nós fica mais perto que a distância mínima", () => {
    const nos = [no("raiz"), no("a"), no("b"), no("a1"), no("a2"), no("b1"), no("b2")];
    const arestas = [
      aresta("e1", "raiz", "a"),
      aresta("e2", "raiz", "b"),
      aresta("e3", "a", "a1"),
      aresta("e4", "a", "a2"),
      aresta("e5", "b", "b1"),
      aresta("e6", "b", "b2"),
    ];

    const posicoes = layoutRadial(nos, arestas);

    expect(menorDistanciaEntrePares(posicoes)).toBeGreaterThanOrEqual(DISTANCIA_MINIMA_NOS - 0.01);
  });

  it("árvore desequilibrada (uma corrente comprida ao lado de um nó só) respeita a distância mínima", () => {
    const nos = [no("raiz"), no("corrente1"), no("corrente2"), no("corrente3"), no("corrente4"), no("solitario")];
    const arestas = [
      aresta("e1", "raiz", "corrente1"),
      aresta("e2", "corrente1", "corrente2"),
      aresta("e3", "corrente2", "corrente3"),
      aresta("e4", "corrente3", "corrente4"),
      aresta("e5", "raiz", "solitario"),
    ];

    const posicoes = layoutRadial(nos, arestas);

    expect(menorDistanciaEntrePares(posicoes)).toBeGreaterThanOrEqual(DISTANCIA_MINIMA_NOS - 0.01);
  });

  it("raiz com muitos filhos diretos (estrela) não empilha os filhos: distância mínima respeitada", () => {
    const filhos = Array.from({ length: 16 }, (_, i) => `filho${i}`);
    const nos = [no("raiz"), ...filhos.map((id) => no(id))];
    const arestas = filhos.map((id, i) => aresta(`e${i}`, "raiz", id));

    const posicoes = layoutRadial(nos, arestas);

    expect(menorDistanciaEntrePares(posicoes)).toBeGreaterThanOrEqual(DISTANCIA_MINIMA_NOS - 0.01);
  });

  it("duas árvores desconexas (dois mapas soltos, ou cartões órfãos do '+ Cartão') não se sobrepõem entre si", () => {
    const nos = [no("raizA"), no("aFilho"), no("raizB"), no("bFilho")];
    const arestas = [aresta("e1", "raizA", "aFilho"), aresta("e2", "raizB", "bFilho")];

    const posicoes = layoutRadial(nos, arestas);

    expect(menorDistanciaEntrePares(posicoes)).toBeGreaterThanOrEqual(DISTANCIA_MINIMA_NOS - 0.01);
  });

  it("grafo com ciclo (o usuário ligou dois nós formando um laço) não trava e ainda respeita a distância mínima", () => {
    const nos = [no("raiz"), no("a"), no("b")];
    // raiz -> a -> b -> raiz: fecha um ciclo. Sem a árvore geradora por BFS
    // (em vez de seguir toda aresta direcionada), isto entraria em loop
    // infinito na recursão de `contarFolhas`/`posicionar`.
    const arestas = [aresta("e1", "raiz", "a"), aresta("e2", "a", "b"), aresta("e3", "b", "raiz")];

    const posicoes = layoutRadial(nos, arestas);

    expect(posicoes.size).toBe(3);
    expect(menorDistanciaEntrePares(posicoes)).toBeGreaterThanOrEqual(DISTANCIA_MINIMA_NOS - 0.01);
  });

  // Defeito B do relatório do usuário: depois de um nó ganhar imagem, o
  // layout radial não pode mais sobrepor cartões — a miniatura torna o
  // cartão mais alto do que `DISTANCIA_MINIMA_NOS` foi calibrado para cobrir.
  //
  // As duas provas abaixo medem a distância de UM PAR específico, não o
  // mínimo global de `menorDistanciaEntrePares`: um grafo com nós de tipos
  // diferentes (com/sem imagem) tem uma distância mínima DIFERENTE por par
  // (soma dos dois raios de exclusão), então o mínimo global reflete sempre
  // o par mais "barato" (dois nós comuns), nunca o par com imagem que estas
  // provas querem checar.
  it("nó com imagem exige mais distância do pai (sem imagem) do que um nó comum exigiria", () => {
    const nos = [no("raiz"), noComImagem("comFoto")];
    const arestas = [aresta("e1", "raiz", "comFoto")];

    const posicoes = layoutRadial(nos, arestas);
    const raiz = posicoes.get("raiz");
    const comFoto = posicoes.get("comFoto");
    if (!raiz || !comFoto) throw new Error("esperava posição definida para 'raiz' e 'comFoto'");
    const distancia = Math.hypot(comFoto.x - raiz.x, comFoto.y - raiz.y);

    // Raio de exclusão de um nó comum é `DISTANCIA_MINIMA_NOS / 2`; de um nó
    // com imagem é `DISTANCIA_MINIMA_NOS_COM_IMAGEM / 2` — o par soma um de
    // cada, nunca dois do maior nem dois do menor.
    const minimoEntreComumEImagem = (DISTANCIA_MINIMA_NOS + DISTANCIA_MINIMA_NOS_COM_IMAGEM) / 2;
    expect(distancia).toBeGreaterThanOrEqual(minimoEntreComumEImagem - 0.01);
  });

  it("dois nós com imagem entre si respeitam a distância mínima maior, mesmo cada um perto de um pai sem imagem", () => {
    const nos = [no("raiz"), noComImagem("a"), noComImagem("b")];
    const arestas = [aresta("e1", "raiz", "a"), aresta("e2", "raiz", "b")];

    const posicoes = layoutRadial(nos, arestas);
    const a = posicoes.get("a");
    const b = posicoes.get("b");
    if (!a || !b) throw new Error("esperava posição definida para 'a' e 'b'");
    const distanciaAB = Math.hypot(b.x - a.x, b.y - a.y);

    expect(distanciaAB).toBeGreaterThanOrEqual(DISTANCIA_MINIMA_NOS_COM_IMAGEM - 0.01);
  });

  it("uma árvore só de nós SEM imagem continua exatamente na distância mínima de sempre", () => {
    // Prova que a mudança acima não afeta o caso comum: o comportamento
    // testado no resto deste arquivo (tudo sem imagem) precisa continuar
    // valendo com o MESMO `DISTANCIA_MINIMA_NOS`, não um valor maior.
    const nos = [no("raiz"), no("a"), no("b")];
    const arestas = [aresta("e1", "raiz", "a"), aresta("e2", "raiz", "b")];

    const posicoes = layoutRadial(nos, arestas);

    const distancia = menorDistanciaEntrePares(posicoes);
    expect(distancia).toBeGreaterThanOrEqual(DISTANCIA_MINIMA_NOS - 0.01);
    expect(distancia).toBeLessThan(DISTANCIA_MINIMA_NOS_COM_IMAGEM);
  });
});
