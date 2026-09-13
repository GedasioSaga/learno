import type { ArestaDoMapa, NoDoMapa } from "./store";

/**
 * Derivações que dependem só da TOPOLOGIA do mapa (quem é nó, quem é aresta,
 * qual a cor de cada nó) — nunca da POSIÇÃO de ninguém na tela. Existem à
 * parte de `ConteudoDeMapaMental.tsx` por dois motivos:
 *
 * 1. Performance: a versão anterior fazia `nos.find(...)` dentro de um
 *    `.map()`/`.some()` sobre `arestas` — O(nós × arestas) — e o
 *    `useMemo` que embrulhava isso dependia do array `nos` INTEIRO, que o
 *    `@xyflow/react` recria a cada `NodeChange` de posição (arrastar = um
 *    `NodeChange` por quadro). Resultado: recalculava o mapa de cor de TODAS
 *    as arestas, e a busca da raiz, a 60fps durante um arrasto — sem nenhum
 *    dos dois de fato precisar saber onde qualquer nó está. Aqui embaixo é
 *    O(nós + arestas): um índice por id construído uma vez, não uma busca
 *    linear repetida por aresta/nó.
 * 2. A independência de posição fica fácil de TESTAR isolada (ver
 *    `desempenho.test.tsx`) e de reusar caso outro lugar precise da mesma
 *    pergunta ("quem é a raiz?", "de que cor é este ramo?").
 */

/**
 * Chave de memoização para `encontrarRaizId`/`corarArestasPorRamo`: muda
 * SOMENTE quando um nó nasce, morre ou troca de cor — nunca quando só a
 * posição muda. Comparação de string em JavaScript é por CONTEÚDO (`===`
 * entre primitivos), não por referência, então um `useMemo` que dependa
 * deste valor (em vez do array `nos` inteiro) não recalcula em cada quadro
 * de arrasto: a string sai idêntica, e o React trata a dependência como
 * "não mudou". `id` sozinho não bastaria (precisa saber se a COR mudou
 * também, já que `corarArestasPorRamo` lê `data.color`).
 */
export function assinaturaDeTopologia(nos: NoDoMapa[]): string {
  return nos.map((no) => `${no.id}:${no.data.color ?? ""}`).join("|");
}

/**
 * O nó raiz do mapa: o único (ou primeiro, com múltiplos órfãos do
 * "+ Cartão") que nenhuma aresta aponta como `target`. Antes: `nos.find`
 * chamando `arestas.some` por candidato — O(nós × arestas). Agora: um `Set`
 * de "quem tem entrada" construído uma vez em O(arestas), consultado em
 * O(1) por nó — O(nós + arestas) no total.
 */
export function encontrarRaizId(nos: NoDoMapa[], arestas: ArestaDoMapa[]): string | null {
  const temEntrada = new Set(arestas.map((aresta) => aresta.target));
  return nos.find((no) => !temEntrada.has(no.id))?.id ?? null;
}

/**
 * Cada aresta ganha a cor do RAMO do seu nó-filho (o `target`) — item 5 do
 * briefing original do mapa mental. Antes: `arestas.map` chamando
 * `nos.find` por aresta — O(arestas × nós). Agora: um `Map` id→cor
 * construído uma vez em O(nós), consultado em O(1) por aresta — O(nós +
 * arestas) no total. `className` (não `style`) porque cor em `style`
 * inline é proibida pelas regras do projeto — quem colore de verdade é
 * `mapa-mental.css`, via a classe.
 */
export function corarArestasPorRamo(nos: NoDoMapa[], arestas: ArestaDoMapa[]): ArestaDoMapa[] {
  const corPorId = new Map(nos.map((no) => [no.id, no.data.color]));
  return arestas.map((aresta) => {
    const cor = corPorId.get(aresta.target);
    return cor ? { ...aresta, className: `mapa-mental-aresta--${cor}` } : aresta;
  });
}
