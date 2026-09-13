import { applyNodeChanges, type NodeChange } from "@xyflow/react";
// `@xyflow/system` não é dependência DIRETA deste projeto (só `@xyflow/react`
// está no `package.json`) — é uma dependência TRANSITIVA do `@xyflow/react`
// já instalada em `node_modules`. Importado aqui só para reusar
// `getNodesInside`, a MESMA função que `onlyRenderVisibleElements` chama por
// dentro (`NodeRenderer`, ver `node_modules/@xyflow/react/dist/esm/index.mjs`)
// — sem isto, medir o ganho da prop exigiria simular pan/zoom de verdade
// pelo motor de gestos num DOM forjado (bem mais caro e frágil que chamar a
// mesma função pura com dados sintéticos). Risco aceito: se uma major
// futura do `@xyflow/react` parar de depender de `@xyflow/system` (ou mudar
// a API de `getNodesInside`), só ESTE arquivo de teste quebra — nenhum
// código de produção importa daqui.
import { getNodesInside, type InternalNodeBase } from "@xyflow/system";
import { describe, expect, it } from "vitest";
import { layoutRadial } from "./layout-radial";
import type { ArestaDoMapa, NoDoMapa } from "./store";
import { corarArestasPorRamo, encontrarRaizId } from "./topologia-do-mapa";

/**
 * Benchmark reproduzível do relatório "as animações do Mapa Mental estão
 * travadas" (ver diagnóstico no prompt da tarefa). Não afirma nada sobre
 * corretude — isso é `layout-radial.test.ts` e o resto da suíte — só mede
 * tempo, ANTES e DEPOIS da otimização, para os três pontos:
 *
 *   1. `layoutRadial` (a etapa O(n²)×300 de `separarSobreposicoes`).
 *   2. `encontrarRaizId`/`corarArestasPorRamo` — a versão NOVA (O(nós +
 *      arestas), independente de posição) contra uma RÉPLICA da versão
 *      ANTIGA (O(nós × arestas), a que rodava dentro do `useMemo` de
 *      `ConteudoDeMapaMental.tsx` a cada quadro de arrasto).
 *
 * `console.log`, não `expect`, para os números: o valor destina-se ao
 * relatório da tarefa (colar antes/depois), não a travar o CI por variação
 * de máquina. As duas asserções que existem (`toBeLessThan`) são só uma
 * rede de segurança contra REGRESSÃO GROSSEIRA (10x mais lento), não um
 * orçamento de performance fino — timing de wall-clock varia demais entre
 * máquinas para um teto apertado.
 */

function no(id: string, color?: string): NoDoMapa {
  return { id, type: "cartaoMental", position: { x: 0, y: 0 }, data: { label: id, color } };
}

function aresta(id: string, source: string, target: string): ArestaDoMapa {
  return { id, source, target };
}

/**
 * Um raiz com `totalNos - 1` filhos diretos — o pior caso conhecido de
 * `separarSobreposicoes`: o arco de cada filho encolhe conforme a raiz
 * ganha mais filhos (etapa 1, `posicionarComponente`), então praticamente
 * todo par de filhos nasce mais perto que `DISTANCIA_MINIMA_NOS` e precisa
 * de várias rodadas de empurrão par a par para se separar. Mesmo formato do
 * teste "estrela" de `layout-radial.test.ts`, só que em escala.
 */
function construirMapaEstrela(totalNos: number): { nos: NoDoMapa[]; arestas: ArestaDoMapa[] } {
  const cores = ["amber", "mint", "azul", "terracotta"];
  const nos: NoDoMapa[] = [no("raiz")];
  const arestas: ArestaDoMapa[] = [];
  for (let i = 0; i < totalNos - 1; i++) {
    const id = `filho${i}`;
    nos.push(no(id, cores[i % cores.length]));
    arestas.push(aresta(`e${i}`, "raiz", id));
  }
  return { nos, arestas };
}

/** Árvore balanceada (4 filhos por nó) — o formato mais comum de mapa
 *  mental real, ao contrário da estrela acima (caso de estresse). */
function construirArvoreBalanceada(
  totalNos: number,
  filhosPorNo = 4,
): { nos: NoDoMapa[]; arestas: ArestaDoMapa[] } {
  const cores = ["amber", "mint", "azul", "terracotta"];
  const nos: NoDoMapa[] = [no("n0")];
  const arestas: ArestaDoMapa[] = [];
  const fila = ["n0"];
  let proximoId = 1;
  let cursorCor = 0;
  while (proximoId < totalNos && fila.length > 0) {
    // shift() nunca retorna undefined aqui: o laço só roda enquanto
    // length > 0, mesma garantia de layout-radial.ts.
    const pai = fila.shift()!;
    for (let i = 0; i < filhosPorNo && proximoId < totalNos; i++) {
      const id = `n${proximoId++}`;
      nos.push(no(id, cores[cursorCor++ % cores.length]));
      arestas.push(aresta(`e-${id}`, pai, id));
      fila.push(id);
    }
  }
  return { nos, arestas };
}

/** Réplica EXATA da versão antiga de `raizId` (`ConteudoDeMapaMental.tsx`,
 *  antes desta tarefa): `nos.find` chamando `arestas.some` por candidato —
 *  O(nós × arestas). Existe só para o benchmark comparativo abaixo. */
function raizIdAntigo(nos: NoDoMapa[], arestas: ArestaDoMapa[]): string | null {
  return nos.find((candidato) => !arestas.some((aresta) => aresta.target === candidato.id))?.id ?? null;
}

/** Réplica EXATA da versão antiga de `arestasComCor`: `arestas.map`
 *  chamando `nos.find` por aresta — O(arestas × nós). Só para benchmark. */
function corarArestasAntigo(nos: NoDoMapa[], arestas: ArestaDoMapa[]): ArestaDoMapa[] {
  return arestas.map((aresta) => {
    const cor = nos.find((candidato) => candidato.id === aresta.target)?.data.color;
    return cor ? { ...aresta, className: `mapa-mental-aresta--${cor}` } : aresta;
  });
}

/** Tempo total (ms) de `repeticoes` chamadas de `fn`, descartado o valor de
 *  retorno — só o relógio interessa aqui. */
function medir(fn: () => void, repeticoes: number): number {
  const inicio = performance.now();
  for (let i = 0; i < repeticoes; i++) fn();
  return performance.now() - inicio;
}

const TAMANHOS = [50, 200, 500];

describe("desempenho do mapa mental (benchmark, não orçamento fino)", () => {
  describe.each(TAMANHOS)("%i nós", (totalNos) => {
    const estrela = construirMapaEstrela(totalNos);
    const balanceada = construirArvoreBalanceada(totalNos);

    // UMA chamada só (não a média de várias): o objetivo aqui não é um
    // orçamento de performance fino, é comprovar a ordem de grandeza
    // antes/depois (ver os números no relatório da tarefa). Rodar só uma
    // vez por tamanho mantém este arquivo leve o bastante pra não competir
    // por CPU com o resto da suíte quando `vitest run` roda tudo em
    // paralelo — a versão ANTIGA de `layoutRadial` chegava a bloquear a
    // thread por ~2,7s com 500 nós, e três repetições desse bloqueio (a
    // versão anterior deste arquivo) já bastavam pra atrasar timers reais
    // de OUTROS arquivos de teste (`userEvent`/`waitFor`) rodando em
    // paralelo — foi assim que uma rodada cheia de `npx vitest run` chegou
    // a mostrar falhas em `cronograma/*.test.tsx`, sem nenhuma relação de
    // código com este arquivo (confirmado rodando a suíte com e sem este
    // arquivo: a falha some sem ele, e nem sempre aparece com ele — é
    // contenção de CPU, não regressão de lógica).
    it(
      `layoutRadial — mapa estrela (pior caso de separarSobreposicoes)`,
      () => {
        const tempoMs = medir(() => layoutRadial(estrela.nos, estrela.arestas), 1);
        console.log(`[bench] layoutRadial estrela ${totalNos} nós: ${tempoMs.toFixed(2)}ms`);
        // Rede de segurança contra regressão grosseira, não orçamento fino
        // (o número real vai no relatório) — 20s cobre até a versão NÃO
        // otimizada com folga, sem travar o CI de verdade se algo piorar
        // muito mais que isso.
        expect(tempoMs).toBeLessThan(20000);
      },
      // Timeout do teste (não da função medida): a versão ainda não
      // otimizada passa de 2s numa única chamada com 500 nós.
      30000,
    );

    it(
      `layoutRadial — árvore balanceada (formato comum de mapa mental)`,
      () => {
        const tempoMs = medir(() => layoutRadial(balanceada.nos, balanceada.arestas), 1);
        console.log(`[bench] layoutRadial balanceada ${totalNos} nós: ${tempoMs.toFixed(2)}ms`);
        expect(tempoMs).toBeLessThan(20000);
      },
      30000,
    );

    it(`encontrarRaizId — novo (O(n+e)) contra a réplica antiga (O(n×e))`, () => {
      const repeticoes = 50;
      const tempoAntigoMs = medir(() => raizIdAntigo(balanceada.nos, balanceada.arestas), repeticoes);
      const tempoNovoMs = medir(() => encontrarRaizId(balanceada.nos, balanceada.arestas), repeticoes);
      console.log(
        `[bench] raizId ${totalNos} nós, ${repeticoes} chamadas — antigo: ${tempoAntigoMs.toFixed(2)}ms, novo: ${tempoNovoMs.toFixed(2)}ms`,
      );
      // Mesmo resultado, sempre — a otimização não pode mudar QUEM é a raiz.
      expect(encontrarRaizId(balanceada.nos, balanceada.arestas)).toBe(raizIdAntigo(balanceada.nos, balanceada.arestas));
    });

    it(`corarArestasPorRamo — novo (O(n+e)) contra a réplica antiga (O(n×e))`, () => {
      const repeticoes = 50;
      const tempoAntigoMs = medir(() => corarArestasAntigo(balanceada.nos, balanceada.arestas), repeticoes);
      const tempoNovoMs = medir(() => corarArestasPorRamo(balanceada.nos, balanceada.arestas), repeticoes);
      console.log(
        `[bench] arestasComCor ${totalNos} nós, ${repeticoes} chamadas — antigo: ${tempoAntigoMs.toFixed(2)}ms, novo: ${tempoNovoMs.toFixed(2)}ms`,
      );
      // Mesmo resultado, sempre — a otimização não pode mudar NENHUMA cor.
      expect(corarArestasPorRamo(balanceada.nos, balanceada.arestas)).toEqual(corarArestasAntigo(balanceada.nos, balanceada.arestas));
    });

    // Ponto 2 do diagnóstico original: "`aoMudarNos`/`aoMudarArestas`
    // substitui o array INTEIRO de nós a cada `NodeChange`". Isso é
    // literalmente verdade (o array de RETORNO é sempre novo — é assim que
    // toda atualização imutável de estado funciona em React/zustand), mas a
    // pergunta que importa é OUTRA: quantos NÓS (objetos) são recriados por
    // dentro, e quanto tempo isso custa por quadro de arrasto (um
    // `NodeChange` de posição por nó movido, tipicamente 1). Mede as duas
    // coisas antes de decidir se vale mexer aqui.
    it(`aoMudarNos (applyNodeChanges) — 1 mudança de posição em ${totalNos} nós`, () => {
      const mudanca: NodeChange<NoDoMapa>[] = [
        { id: balanceada.nos[0].id, type: "position", position: { x: 123, y: 456 }, dragging: true },
      ];
      const repeticoes = 500;
      const tempoMs = medir(() => applyNodeChanges(mudanca, balanceada.nos), repeticoes);
      const resultado = applyNodeChanges(mudanca, balanceada.nos);
      // Estrutural: só o nó QUE MUDOU ganha uma referência nova — os outros
      // `totalNos - 1` continuam apontando pro MESMO objeto de antes. Se
      // isso for verdade, `applyNodeChanges` não é O(n) por causa de
      // recriar dado (é O(n) só pra copiar o ARRAY de referências, que é
      // barato), e o ponto 2 do diagnóstico não é o gargalo real.
      const referenciasReaproveitadas = resultado.filter((no, i) => no === balanceada.nos[i]).length;
      console.log(
        `[bench] applyNodeChanges ${totalNos} nós, ${repeticoes} chamadas: ${tempoMs.toFixed(2)}ms total (${(tempoMs / repeticoes).toFixed(4)}ms/chamada) — ${referenciasReaproveitadas}/${totalNos - 1} nós NÃO movidos mantiveram a mesma referência`,
      );
      expect(referenciasReaproveitadas).toBe(totalNos - 1);
    });
  });

  // Ponto 5 do diagnóstico: `onlyRenderVisibleElements` (desligado por
  // padrão no `<ReactFlow>`). Medir o ganho de verdade (menos elementos no
  // DOM, não tempo de CPU) exigiria simular pan/zoom pelo motor de gestos
  // num DOM forjado — caro e fora do alcance de um teste rápido em jsdom
  // (que não faz layout/paint reais de qualquer forma, então cronometrar
  // "quanto tempo leva pra pintar" não diria nada aqui). Em vez disso, esta
  // seção chama `getNodesInside` — a MESMA função que
  // `NodeRenderer`/`useVisibleNodeIds` usam por dentro quando a prop está
  // ligada — com posições REAIS de `layoutRadial` e um viewport plausível
  // (1200×800px, o tamanho comum de uma janela de app desktop), simulando o
  // usuário já ter dado zoom numa PARTE do mapa (não o `fitView` inicial,
  // que por definição mostra tudo). O número que sai daqui é literalmente
  // "quantos cartões o `<ReactFlow>` deixaria de montar no DOM" — a métrica
  // que realmente importa pra essa prop (ela não muda quanto tempo uma
  // função leva, muda QUANTOS elementos existem pro navegador desenhar).
  describe("onlyRenderVisibleElements — quantos cartões ficam de fora de um viewport plausível", () => {
    const LARGURA_VIEWPORT = 1200;
    const ALTURA_VIEWPORT = 800;
    const LARGURA_CARTAO = 200; // meio do intervalo `min-w-32 max-w-64` de `CartaoNode.tsx` (128–256px).
    const ALTURA_CARTAO = 80;

    function paraNoInterno(id: string, posicao: { x: number; y: number }): InternalNodeBase<NoDoMapa> {
      return {
        id,
        type: "cartaoMental",
        position: posicao,
        data: { label: id },
        measured: { width: LARGURA_CARTAO, height: ALTURA_CARTAO },
        internals: {
          positionAbsolute: posicao,
          z: 0,
          userNode: { id, type: "cartaoMental", position: posicao, data: { label: id } },
          // Truthy de propósito: `getNodesInside` força um nó SEM
          // `handleBounds` a sempre aparecer "visível" (dar ao
          // `@xyflow/react` a chance de medi-lo uma vez) — aqui queremos o
          // estado ESTÁVEL, depois do mapa já ter carregado e o usuário
          // estar navegando por ele, não o instante do primeiro render.
          handleBounds: { source: [], target: [] },
        },
      };
    }

    it("mapa de 500 nós, usuário com zoom 2x centrado na raiz: a maioria fica fora do viewport", () => {
      const totalNos = 500;
      const { nos, arestas } = construirArvoreBalanceada(totalNos);
      const posicoes = layoutRadial(nos, arestas);

      const nodeLookup = new Map<string, InternalNodeBase<NoDoMapa>>();
      for (const no of nos) {
        const posicao = posicoes.get(no.id);
        if (posicao) nodeLookup.set(no.id, paraNoInterno(no.id, posicao));
      }

      // zoom 2x, câmera centrada na raiz (posição 0,0 em coordenadas do
      // mapa): `tScale=2`, `tx`/`ty` deslocam a origem do mapa pro centro da
      // tela — mesma convenção de transform que `lerTransformDoViewport` lê
      // de `ConteudoDeMapaMental.test.tsx` (translate + scale).
      const tScale = 2;
      const transform: [number, number, number] = [LARGURA_VIEWPORT / 2, ALTURA_VIEWPORT / 2, tScale];

      const semCulling = nodeLookup.size; // é isto que renderiza HOJE (todo mundo).
      const comCulling = getNodesInside(
        nodeLookup,
        { x: 0, y: 0, width: LARGURA_VIEWPORT, height: ALTURA_VIEWPORT },
        transform,
        true,
      ).length;

      console.log(
        `[bench] onlyRenderVisibleElements, ${totalNos} nós, zoom ${tScale}x: hoje monta ${semCulling} cartões; com a prop ligada, ${comCulling}`,
      );

      // Não é um número exato "de negócio" (depende do formato do mapa) —
      // só a afirmação central: zoom 2x num mapa de 500 nós deixa a maior
      // parte fora da tela, então a prop tem trabalho de verdade pra fazer.
      expect(comCulling).toBeLessThan(semCulling);
      expect(comCulling).toBeLessThan(semCulling / 2);
    });

    it("mapa pequeno (30 nós) com fitView (mostra tudo): a prop não teria nada pra cortar", () => {
      // Contraste com o caso acima: um mapa "das dezenas de nós" (o comum,
      // por `RODADAS_MAX_SEPARACAO`) visto por INTEIRO — exatamente o que
      // `fitView` (prop fixa do `<ReactFlow>`) mostra assim que o mapa abre.
      // Aqui não há ganho nenhum: é por isso que a prop só ajuda DEPOIS que
      // o usuário navega, não no estado inicial.
      const totalNos = 30;
      const { nos, arestas } = construirArvoreBalanceada(totalNos);
      const posicoes = layoutRadial(nos, arestas);

      const nodeLookup = new Map<string, InternalNodeBase<NoDoMapa>>();
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const no of nos) {
        const posicao = posicoes.get(no.id);
        if (!posicao) continue;
        nodeLookup.set(no.id, paraNoInterno(no.id, posicao));
        minX = Math.min(minX, posicao.x);
        maxX = Math.max(maxX, posicao.x);
        minY = Math.min(minY, posicao.y);
        maxY = Math.max(maxY, posicao.y);
      }

      // `fitView` com zoom que cabe a bounding box inteira num viewport de
      // 1200×800 — a mesma conta que `@xyflow/system` faz por dentro
      // (menor entre largura/altura disponível, com folga).
      const larguraMapa = Math.max(maxX - minX, 1);
      const alturaMapa = Math.max(maxY - minY, 1);
      const tScale = Math.min(LARGURA_VIEWPORT / (larguraMapa + LARGURA_CARTAO), ALTURA_VIEWPORT / (alturaMapa + ALTURA_CARTAO), 1);
      const centroX = (minX + maxX) / 2;
      const centroY = (minY + maxY) / 2;
      const transform: [number, number, number] = [
        LARGURA_VIEWPORT / 2 - centroX * tScale,
        ALTURA_VIEWPORT / 2 - centroY * tScale,
        tScale,
      ];

      const semCulling = nodeLookup.size;
      const comCulling = getNodesInside(
        nodeLookup,
        { x: 0, y: 0, width: LARGURA_VIEWPORT, height: ALTURA_VIEWPORT },
        transform,
        true,
      ).length;

      console.log(`[bench] onlyRenderVisibleElements, ${totalNos} nós, fitView: hoje monta ${semCulling}; com a prop, ${comCulling}`);
      expect(comCulling).toBe(semCulling);
    });
  });
});
