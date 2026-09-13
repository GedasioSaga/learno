import type { ArestaDoMapa, NoDoMapa } from "./store";

export interface PosicaoDoNo {
  x: number;
  y: number;
}

/**
 * Distância mínima (px, centro a centro) que o layout garante entre
 * QUAISQUER dois nós, e a mesma constante que `layout-radial.test.ts` usa
 * pra checar essa garantia — nunca reescreva o número duas vezes.
 *
 * É uma aproximação: trata cada cartão como um círculo de exclusão, não a
 * caixa retangular real (`min-w-32 max-w-64` em `CartaoNode.tsx`, 128–256px
 * de largura mais a altura do texto). 200px cobre a largura mínima com folga
 * e é o valor mais fácil de justificar sem medir cada cartão renderizado —
 * a etapa 2 abaixo (`separarSobreposicoes`) é quem garante o mínimo de
 * verdade, não a matemática angular da etapa 1, então esta constante só
 * precisa ser "razoável", não perfeita.
 */
export const DISTANCIA_MINIMA_NOS = 200;

/** Metade de `DISTANCIA_MINIMA_NOS` — o "raio de exclusão" de um nó SEM
 *  imagem, que `separarSobreposicoes` soma par a par (ver lá): dois nós
 *  comuns exigem `RAIO_EXCLUSAO_PADRAO * 2 === DISTANCIA_MINIMA_NOS` entre
 *  si, exatamente o comportamento de antes desta constante existir. */
const RAIO_EXCLUSAO_PADRAO = DISTANCIA_MINIMA_NOS / 2;

/**
 * Distância mínima quando PELO MENOS UM dos dois nós tem imagem
 * (`data.image`, `CartaoNode.tsx`). `DISTANCIA_MINIMA_NOS` foi calibrado
 * para uma caixa de texto (128–256px de largura mais uma ou duas linhas —
 * ver o comentário dela); a miniatura que `CartaoNode.tsx` desenha em cima
 * do rótulo torna o cartão bem mais ALTO do que isso, e sem uma exclusão
 * maior dois nós com imagem nascidos a exatamente `DISTANCIA_MINIMA_NOS` um
 * do outro se sobrepõem na tela mesmo a etapa 2 (`separarSobreposicoes`)
 * tendo "cumprido" o mínimo antigo.
 */
export const DISTANCIA_MINIMA_NOS_COM_IMAGEM = 320;
const RAIO_EXCLUSAO_COM_IMAGEM = DISTANCIA_MINIMA_NOS_COM_IMAGEM / 2;

/** O raio de exclusão de UM nó — metade da distância mínima que ele impõe a
 *  qualquer vizinho. `separarSobreposicoes` soma o raio dos dois lados do
 *  par, então um nó com imagem ao lado de um nó sem imagem exige a MÉDIA
 *  das duas distâncias mínimas, nunca a maior nem a menor sozinha. */
function raioDeExclusao(no: NoDoMapa | undefined): number {
  return no?.data.image ? RAIO_EXCLUSAO_COM_IMAGEM : RAIO_EXCLUSAO_PADRAO;
}

/** Espaçamento radial entre uma geração e a próxima. Maior que
 *  `DISTANCIA_MINIMA_NOS` para a raiz e seus filhos diretos já nascerem
 *  espaçados sem precisar de correção. */
const RAIO_POR_NIVEL = 220;

/** Margem horizontal entre duas árvores desconexas (dois mapas soltos, ou
 *  nós órfãos do "+ Cartão" sem aresta nenhuma) postas lado a lado. */
const MARGEM_ENTRE_COMPONENTES = DISTANCIA_MINIMA_NOS * 2;

/** Teto de rodadas da etapa 2. Convergência é O(rodadas × n²) no pior caso
 *  teórico (ver `separarSobreposicoes` para a otimização real, que evita
 *  bater nesse teto na prática); mapas mentais reais ficam na casa das
 *  dezenas de nós, então isto sobra sem custar caro (o botão "Organizar"
 *  roda sob clique, não a cada quadro). */
const RODADAS_MAX_SEPARACAO = 300;

/**
 * Layout radial clássico: a raiz no centro, cada geração num anel mais
 * afastado, e o arco de cada nó proporcional ao número de folhas da sua
 * subárvore — é o que faz um mapa com um ramo de 10 ideias e outro de 2 não
 * empilhar os 10 em cima uns dos outros. Função PURA: só lê `nos`/`arestas`,
 * nunca toca em estado — quem persiste o resultado é
 * `organizarLayoutRadial` em `store.ts`.
 *
 * Duas etapas, deliberadamente separadas:
 * 1. `posicionarComponente` calcula uma posição analítica por
 *    ângulo/profundidade — dá a "cara" de mapa radial reconhecível.
 * 2. `separarSobreposicoes` é quem de fato GARANTE a distância mínima: a
 *    etapa 1 sozinha pode falhar nisso quando um nó tem MUITOS filhos
 *    diretos (o arco de cada um encolhe, mas o raio do anel é fixo) — em vez
 *    de tentar provar que a fórmula angular nunca colide para qualquer
 *    formato de árvore, a etapa 2 empurra qualquer par próximo demais pra
 *    longe até ninguém mais violar o mínimo. Robusto a qualquer forma de
 *    árvore, inclusive as que a etapa 1 não previu.
 *
 * Aceita grafo com ciclo (o usuário pode ligar dois nós formando um laço
 * arrastando pela alça) sem travar: a árvore usada pro cálculo angular é uma
 * árvore geradora por BFS não-direcionado a partir da raiz de cada
 * componente, então uma aresta "extra" que fecharia um ciclo simplesmente
 * não entra na árvore — ela continua sendo desenhada pelo canvas, só não
 * participa do cálculo de posição.
 */
export function layoutRadial(nos: NoDoMapa[], arestas: ArestaDoMapa[]): Map<string, PosicaoDoNo> {
  const posicoes = new Map<string, PosicaoDoNo>();
  if (nos.length === 0) return posicoes;

  const vizinhos = new Map<string, Set<string>>();
  for (const no of nos) vizinhos.set(no.id, new Set());
  for (const aresta of arestas) {
    vizinhos.get(aresta.source)?.add(aresta.target);
    vizinhos.get(aresta.target)?.add(aresta.source);
  }

  // Quem tem pai numa aresta DIRECIONADA (source → target) — usado só pra
  // escolher a raiz de cada componente, nunca pra montar a árvore em si
  // (isso é BFS não-direcionado, dentro de `posicionarComponente`).
  const temPaiDirecionado = new Set<string>();
  for (const aresta of arestas) temPaiDirecionado.add(aresta.target);

  const visitadoComponente = new Set<string>();
  let cursorX = 0;

  for (const noInicial of nos) {
    if (visitadoComponente.has(noInicial.id)) continue;

    // Componente conexa (não-direcionada) a partir deste nó, por BFS.
    const componente: string[] = [];
    const filaComponente = [noInicial.id];
    visitadoComponente.add(noInicial.id);
    while (filaComponente.length > 0) {
      // shift() nunca retorna undefined aqui: o laço só continua enquanto
      // length > 0, então o array não está vazio no momento do shift.
      const atual = filaComponente.shift()!;
      componente.push(atual);
      for (const vizinho of vizinhos.get(atual) ?? []) {
        if (!visitadoComponente.has(vizinho)) {
          visitadoComponente.add(vizinho);
          filaComponente.push(vizinho);
        }
      }
    }

    const raizId = componente.find((id) => !temPaiDirecionado.has(id)) ?? componente[0];
    const larguraComponente = posicionarComponente(componente, raizId, vizinhos, cursorX, posicoes);
    cursorX += larguraComponente + MARGEM_ENTRE_COMPONENTES;
  }

  separarSobreposicoes(posicoes, nos);
  return posicoes;
}

/**
 * Posiciona uma componente conexa inteira em volta de `raizId`, com o centro
 * da raiz em `centroX`. Devolve a largura ocupada (maxX - minX), pro
 * chamador saber onde começar a próxima componente.
 */
function posicionarComponente(
  componente: string[],
  raizId: string,
  vizinhos: Map<string, Set<string>>,
  centroX: number,
  posicoes: Map<string, PosicaoDoNo>,
): number {
  // Árvore geradora por BFS não-direcionado: garante acíclico mesmo se o
  // grafo original tiver um laço (ver comentário de `layoutRadial`).
  const filhosNaArvore = new Map<string, string[]>();
  for (const id of componente) filhosNaArvore.set(id, []);
  const visitadoArvore = new Set([raizId]);
  const filaArvore = [raizId];
  while (filaArvore.length > 0) {
    // mesmo raciocínio do `shift()` acima: o laço só roda com length > 0.
    const atual = filaArvore.shift()!;
    for (const vizinho of vizinhos.get(atual) ?? []) {
      if (!visitadoArvore.has(vizinho)) {
        visitadoArvore.add(vizinho);
        filhosNaArvore.get(atual)?.push(vizinho);
        filaArvore.push(vizinho);
      }
    }
  }

  const cacheDeFolhas = new Map<string, number>();
  function contarFolhas(id: string): number {
    const cache = cacheDeFolhas.get(id);
    if (cache !== undefined) return cache;
    const filhos = filhosNaArvore.get(id) ?? [];
    const total = filhos.length === 0 ? 1 : filhos.reduce((soma, filho) => soma + contarFolhas(filho), 0);
    cacheDeFolhas.set(id, total);
    return total;
  }

  function posicionar(id: string, anguloInicio: number, anguloFim: number, profundidade: number) {
    const anguloMeio = (anguloInicio + anguloFim) / 2;
    const raio = profundidade * RAIO_POR_NIVEL;
    posicoes.set(id, {
      x: centroX + raio * Math.cos(anguloMeio),
      y: raio * Math.sin(anguloMeio),
    });

    const filhos = filhosNaArvore.get(id) ?? [];
    if (filhos.length === 0) return;
    const totalFolhas = contarFolhas(id);
    let anguloAtual = anguloInicio;
    for (const filho of filhos) {
      const fatia = (contarFolhas(filho) / totalFolhas) * (anguloFim - anguloInicio);
      posicionar(filho, anguloAtual, anguloAtual + fatia, profundidade + 1);
      anguloAtual += fatia;
    }
  }
  posicionar(raizId, 0, Math.PI * 2, 0);

  let minX = Infinity;
  let maxX = -Infinity;
  for (const id of componente) {
    const posicao = posicoes.get(id);
    if (!posicao) continue;
    minX = Math.min(minX, posicao.x);
    maxX = Math.max(maxX, posicao.x);
  }
  return maxX - minX;
}

/**
 * Tamanho de célula da grade usada por `separarSobreposicoes` para achar
 * pares próximos sem comparar todo mundo com todo mundo — ver o comentário
 * daquela função. Precisa ser ≥ à MAIOR distância mínima possível entre um
 * par (dois nós com imagem, `DISTANCIA_MINIMA_NOS_COM_IMAGEM`): com célula
 * desse tamanho, dois pontos mais perto do que ela caem garantidamente na
 * mesma célula ou numa das 8 vizinhas (nunca mais longe) — é a mesma conta
 * de qualquer grade uniforme de busca por proximidade (célula ≥ raio de
 * busca ⇒ 3×3 células cobre toda a vizinhança).
 */
const TAMANHO_DE_CELULA_DA_GRADE = DISTANCIA_MINIMA_NOS_COM_IMAGEM;

/**
 * Resolve UM par que violou a distância mínima, empurrando os dois para
 * longe na direção da reta que os liga — mesma matemática de sempre, só
 * extraída para ficar isolada da enumeração de pares (grade, abaixo).
 * Devolve se algum ajuste foi feito (`false` quando o par já respeitava a
 * distância mínima).
 */
function resolverPar(
  posicoes: Map<string, PosicaoDoNo>,
  idA: string,
  idB: string,
  distanciaMinima: number,
  anguloDeterministico: number,
): boolean {
  // Ambos presentes em `posicoes` por construção: só chamamos com ids que
  // vieram de `[...posicoes.keys()]`, e o `Map` só é editado com `.set` em
  // ids já existentes (nunca `.delete`).
  const a = posicoes.get(idA)!;
  const b = posicoes.get(idB)!;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let distancia = Math.hypot(dx, dy);

  if (distancia === 0) {
    dx = Math.cos(anguloDeterministico);
    dy = Math.sin(anguloDeterministico);
    distancia = 1;
  }

  if (distancia >= distanciaMinima) return false;

  const falta = (distanciaMinima - distancia) / 2;
  const ux = dx / distancia;
  const uy = dy / distancia;
  posicoes.set(idA, { x: a.x - ux * falta, y: a.y - uy * falta });
  posicoes.set(idB, { x: b.x + ux * falta, y: b.y + uy * falta });
  return true;
}

/**
 * Metade da vizinhança de 8 células (mais a própria célula, tratada à
 * parte dentro de `separarSobreposicoes`): junto com "pares dentro da mesma
 * célula", estes 4 deslocamentos cobrem as 8 vizinhas sem visitar o mesmo
 * par de células duas vezes — a célula (0,0) enxerga (1,0), mas (1,0) nunca
 * "olha de volta" para (0,0) (isso exigiria o deslocamento (-1,0), que não
 * está nesta lista). É a técnica clássica de grade espacial para checagem
 * de proximidade sem precisar de um `Set` de pares já vistos (mais barato:
 * nada de montar/hashear uma string por par candidato).
 */
const DESLOCAMENTOS_METADE_DA_VIZINHANCA: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [-1, 1],
];

/**
 * Etapa 2 do layout: empurra todo par de nós mais próximo que a distância
 * mínima DAQUELE PAR para longe um do outro, na direção da reta que os liga,
 * até ninguém mais violar o mínimo (ou até o teto de rodadas). A distância
 * mínima não é mais um único número fixo: é a soma do raio de exclusão de
 * cada nó (`raioDeExclusao`) — `DISTANCIA_MINIMA_NOS` continua sendo o
 * resultado para dois nós comuns (a soma de dois raios padrão), mas um par
 * onde pelo menos um lado tem imagem exige mais espaço. Nós exatamente
 * coincidentes (raio 0 na etapa 1, ex.: dois filhos únicos empilhados) usam
 * uma direção determinística baseada no índice de cada um, pra nunca
 * normalizar um vetor de comprimento zero.
 *
 * A comparação de pares usa uma GRADE espacial, reconstruída a cada rodada,
 * em vez do duplo laço O(n²) de antes: cada nó só é comparado com quem está
 * na mesma célula ou numa das 8 vizinhas (`TAMANHO_DE_CELULA_DA_GRADE`
 * garante que nenhum par realmente próximo escapa disso), então o custo por
 * rodada cai para O(n × vizinhos médios) em vez de O(n²) — para um mapa
 * espalhado pelo plano (não todo empilhado numa área do tamanho de uma
 * célula), isso fica perto de O(n). Medido (`desempenho.test.ts`): uma
 * árvore balanceada de 500 nós caiu de ~2,7s para ~0,3s por chamada de
 * `layoutRadial` (~9x); o caso "estrela" (500 filhos diretos da raiz, todos
 * no mesmo anel — em princípio o pior caso para QUALQUER grade, já que os
 * 500 pontos cabem num raio pequeno) teve o MESMO ganho (~2,6s para
 * ~0,29s): a metade da vizinhança ainda concentra as comparações em poucas
 * células cheias, mas evitar o `Set` de pares já vistos (ver
 * `DESLOCAMENTOS_METADE_DA_VIZINHANCA`) e o duplo laço completo por nó
 * (agora é por CÉLULA) cortou o fator constante o bastante pra também valer
 * a pena aqui.
 *
 * A grade é reconstruída DO ZERO a cada rodada (não incrementalmente): como
 * ela reflete a posição de INÍCIO da rodada, um nó que se move DURANTE a
 * rodada pode ficar temporariamente numa célula "errada" para o resto
 * daquela mesma rodada — o par que ele passou a violar só é detectado na
 * rodada SEGUINTE (a próxima reconstrução pega a posição atualizada). Isso
 * nunca causa uma parada prematura incorreta: a rodada que efetivamente para
 * o laço (`houveAjuste` continua `false` do início ao fim) é, por definição,
 * uma rodada em que NENHUM par se moveu — logo a grade daquela rodada
 * específica já refletia o estado final, sem nada para escapar. No pior
 * caso, uma sobreposição nova (criada por um ajuste no meio da rodada) só
 * adia a própria resolução por uma rodada a mais, dentro do teto de
 * `RODADAS_MAX_SEPARACAO`.
 */
function separarSobreposicoes(posicoes: Map<string, PosicaoDoNo>, nos: NoDoMapa[]): void {
  const ids = [...posicoes.keys()];
  const porId = new Map(nos.map((no) => [no.id, no]));
  // Índice estável (não muda entre rodadas, `ids` também não) — só para dar
  // um ângulo determinístico ao caso de distância zero, mesmo papel do
  // `i`/`j` da versão anterior (baseada em posição no array, não na grade).
  const indicePorId = new Map(ids.map((id, indice) => [id, indice]));

  function distanciaMinimaEAngulo(idA: string, idB: string): { distanciaMinima: number; anguloDeterministico: number } {
    // Ambos vieram de `ids` — sempre presentes em `indicePorId`, que mapeia
    // exatamente `ids`.
    const indiceA = indicePorId.get(idA)!;
    const indiceB = indicePorId.get(idB)!;
    return {
      distanciaMinima: raioDeExclusao(porId.get(idA)) + raioDeExclusao(porId.get(idB)),
      anguloDeterministico: ((indiceA * 47 + indiceB * 13) % 360) * (Math.PI / 180),
    };
  }

  for (let rodada = 0; rodada < RODADAS_MAX_SEPARACAO; rodada++) {
    let houveAjuste = false;

    // Grade reconstruída do zero a cada rodada (ver o "porquê" completo no
    // comentário acima). `cx`/`cy` ficam guardados junto com a lista de ids
    // para não precisar re-parsear a chave string ao visitar cada célula.
    const grade = new Map<string, { cx: number; cy: number; ids: string[] }>();
    for (const id of ids) {
      // Presente por construção — ver o comentário de `resolverPar`.
      const posicao = posicoes.get(id)!;
      const cx = Math.floor(posicao.x / TAMANHO_DE_CELULA_DA_GRADE);
      const cy = Math.floor(posicao.y / TAMANHO_DE_CELULA_DA_GRADE);
      const chave = `${cx},${cy}`;
      const celula = grade.get(chave);
      if (celula) celula.ids.push(id);
      else grade.set(chave, { cx, cy, ids: [id] });
    }

    for (const celula of grade.values()) {
      // Pares DENTRO da mesma célula: duplo laço, mas só entre quem já caiu
      // nela — tipicamente uma fração pequena de `ids.length`.
      for (let i = 0; i < celula.ids.length; i++) {
        for (let j = i + 1; j < celula.ids.length; j++) {
          const idA = celula.ids[i];
          const idB = celula.ids[j];
          const { distanciaMinima, anguloDeterministico } = distanciaMinimaEAngulo(idA, idB);
          if (resolverPar(posicoes, idA, idB, distanciaMinima, anguloDeterministico)) houveAjuste = true;
        }
      }

      // Pares contra a METADE da vizinhança (ver o comentário da constante
      // `DESLOCAMENTOS_METADE_DA_VIZINHANCA`): cada ponto desta célula
      // contra cada ponto da célula vizinha, sem dedup extra — a outra
      // metade da vizinhança nunca "olha de volta" para esta célula.
      for (const [deltaX, deltaY] of DESLOCAMENTOS_METADE_DA_VIZINHANCA) {
        const vizinha = grade.get(`${celula.cx + deltaX},${celula.cy + deltaY}`);
        if (!vizinha) continue;
        for (const idA of celula.ids) {
          for (const idB of vizinha.ids) {
            const { distanciaMinima, anguloDeterministico } = distanciaMinimaEAngulo(idA, idB);
            if (resolverPar(posicoes, idA, idB, distanciaMinima, anguloDeterministico)) houveAjuste = true;
          }
        }
      }
    }

    if (!houveAjuste) break;
  }
}
