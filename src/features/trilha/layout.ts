import type { EtapaDaTrilha, FlechaDaTrilha, RaiaDaTrilha } from "../../lib/ipc";

/**
 * Layout da Trilha — função PURA: só lê `etapas`/`flechas`/`raias`, nunca
 * toca em estado nem em DOM. `TrilhaCanvas.tsx` é quem transforma o
 * resultado em nós/arestas do `@xyflow/react`.
 *
 * A regra que manda (docs/DESIGN-TRILHA.md §1, e a migração 0023): o eixo
 * horizontal é DEPENDÊNCIA, não tempo. A COLUNA de uma etapa é `etapa.level`
 * — vindo pronto do backend, nunca recalculado aqui — e a FAIXA é a raia
 * dela. Não existe coordenada gravada: cada leitura desta função dá uma
 * geometria nova a partir do grafo atual.
 *
 * As réguas abaixo são cópia de `src/features/trilha/trilha.css` (não é meu
 * arquivo — só leio). Se mexer num valor lá, mexa aqui também; os dois não
 * têm uma fonte só porque o CSS não é importável de um módulo `.ts` puro
 * (`getComputedStyle` exigiria montar num DOM real, o que tiraria a pureza e
 * a velocidade dos testes).
 */
const ETAPA_LARGURA = 225; // --trilha-etapa-largura: 15rem
const ETAPA_ALTURA_MIN = 60; // --trilha-etapa-altura-min: 4rem
const GAP_COLUNA = 90; // --trilha-gap-coluna: 6rem
const GAP_LINHA = 22.5; // --trilha-gap-linha: 1.5rem
const PASSO_COLUNA = ETAPA_LARGURA + GAP_COLUNA; // --trilha-coluna-passo: 21rem
const RAIA_CABECALHO_ALTURA = 37.5; // --trilha-raia-cabecalho-altura: 2.5rem
const NIVEL_ROTULO_ALTURA = 26.25; // --trilha-nivel-rotulo-altura: 1.75rem

/**
 * Quanto um cartão cresce além de `ETAPA_ALTURA_MIN` quando carrega a linha
 * de selo + a frase de situação ("Caminho descartado — …", duas linhas de
 * 11px) — ver `.trilha-etapa__selo`/`.trilha-etapa__situacao` em trilha.css.
 * É uma ESTIMATIVA (o layout é puro e não mede DOM); o que ela precisa
 * garantir é só que a linha de baixo não nasça em cima deste cartão — antes
 * disto, no cenário com decisão, "Estrutura da prova IELTS" cobria
 * "Estrutura da prova TOEFL" porque toda linha media 60px fixos.
 */
const ACRESCIMO_POR_SITUACAO_NO_CAMINHO = 52;
/** Só a linha de selo (o "Marco" de `orientacao.ts`, sem frase de situação embaixo). */
const ACRESCIMO_POR_LINHA_DE_SELO = 20;
/** Espelha `MINIMO_DE_PRE_REQUISITOS_PARA_MARCO` de `orientacao.ts` — repetido aqui para o layout não importar um módulo que importa este. */
const MINIMO_DE_PRE_REQUISITOS_PARA_MARCO = 2;

export { ETAPA_LARGURA, ETAPA_ALTURA_MIN, GAP_COLUNA, GAP_LINHA, PASSO_COLUNA, RAIA_CABECALHO_ALTURA, NIVEL_ROTULO_ALTURA };

/** A altura que o cartão desta etapa deve ocupar no layout — mínima, ou mínima + selo/situação. */
export function alturaEstimadaDaEtapa(etapa: EtapaDaTrilha, flechas: readonly FlechaDaTrilha[]): number {
  if (etapa.situacaoNoCaminho !== "ativo") return ETAPA_ALTURA_MIN + ACRESCIMO_POR_SITUACAO_NO_CAMINHO;
  const preRequisitos = flechas.filter((flecha) => flecha.blockedId === etapa.id).length;
  return preRequisitos >= MINIMO_DE_PRE_REQUISITOS_PARA_MARCO ? ETAPA_ALTURA_MIN + ACRESCIMO_POR_LINHA_DE_SELO : ETAPA_ALTURA_MIN;
}

/** O retângulo de uma etapa, em px, no espaço do canvas. */
export interface PosicaoDaEtapa {
  x: number;
  y: number;
  width: number;
  height: number;
  /** `false` quando a raia dela está recolhida — a etapa continua existindo (e sai na lista de leitor de tela), só não ocupa lugar visível no canvas. */
  visivel: boolean;
}

/** Uma faixa horizontal já com a extensão vertical calculada. */
export interface FaixaDaRaia {
  laneValue: string;
  y: number;
  height: number;
  isCollapsed: boolean;
}

export interface ResultadoDoLayout {
  posicoes: Map<string, PosicaoDaEtapa>;
  faixas: FaixaDaRaia[];
  /** Quantidade de níveis (colunas) — 1 no mínimo, mesmo sem etapa nenhuma, para a coluna "raiz" aparecer vazia. */
  totalNiveis: number;
  largura: number;
  altura: number;
}

function menorInteiroLivre(usados: Set<number>): number {
  let candidato = 0;
  while (usados.has(candidato)) candidato++;
  return candidato;
}

/**
 * Dá a cada etapa de uma raia uma LINHA (posição vertical dentro da faixa),
 * de forma que nenhuma outra etapa do MESMO nível (mesma coluna) fique na
 * mesma linha — é essa a única garantia que impede sobreposição, porque
 * colunas diferentes já não se tocam em x (a distância entre elas é
 * `GAP_COLUNA`, sempre positiva).
 *
 * Usa `flechas` para tentar alinhar uma etapa na MESMA linha da sua única
 * bloqueadora (quando essa linha está livre no nível da etapa) — puro
 * acabamento visual (a flecha sai mais reta), nunca afeta a garantia acima:
 * se a linha preferida já estiver ocupada no nível de destino, cai para a
 * menor linha livre.
 *
 * A ordem dentro do MESMO nível é por `position` (índice fracionário de
 * `pages.position`, o mesmo que `movePage` escreve) — NUNCA por `title`.
 * Ordenar por título travava qualquer inversão de ordem sem renomear a
 * etapa (o problema real do usuário: "Data Engineer" sempre antes de "Data
 * Science" na mesma raia, porque E vem antes de S). `id` continua como
 * desempate final para o caso (hoje só teórico) de duas etapas com a mesma
 * `position`.
 */
function atribuirLinhas(etapasDaRaia: EtapaDaTrilha[], flechas: FlechaDaTrilha[]): Map<string, number> {
  const linhaDaEtapa = new Map<string, number>();
  const ocupacaoPorNivel = new Map<number, Set<number>>();

  const ordenadas = [...etapasDaRaia].sort((a, b) => a.level - b.level || a.position.localeCompare(b.position) || a.id.localeCompare(b.id));

  for (const etapa of ordenadas) {
    const bloqueadoras = flechas.filter((flecha) => flecha.blockedId === etapa.id).map((flecha) => flecha.blockingId);
    const ocupadas = ocupacaoPorNivel.get(etapa.level) ?? new Set<number>();

    let linha: number | null = null;
    if (bloqueadoras.length === 1) {
      const linhaDaBloqueadora = linhaDaEtapa.get(bloqueadoras[0]);
      if (linhaDaBloqueadora !== undefined && !ocupadas.has(linhaDaBloqueadora)) {
        linha = linhaDaBloqueadora;
      }
    }
    if (linha === null) linha = menorInteiroLivre(ocupadas);

    ocupadas.add(linha);
    ocupacaoPorNivel.set(etapa.level, ocupadas);
    linhaDaEtapa.set(etapa.id, linha);
  }

  return linhaDaEtapa;
}

/** Uma raia sintética (sem `trail_lanes` por trás) — mesmo formato usado tanto pelo fallback do TRL-014 quanto pela faixa "Sem raia" abaixo. */
function raiaSintetica(laneValue: string, position: string): RaiaDaTrilha {
  return { viewId: "", laneValue, position, isCollapsed: false, createdAt: "", updatedAt: "" };
}

/** Verdadeiro quando `laneValue` bate com o `laneValue` de alguma raia real do contrato. */
function laneReconhecida(laneValue: string, raias: RaiaDaTrilha[]): boolean {
  return raias.some((raia) => raia.laneValue === laneValue);
}

/**
 * A raia a que uma etapa PERTENCE, para fins de agrupamento/exibição: a
 * própria `etapa.laneValue`, se casa com alguma raia do contrato — senão a
 * faixa catch-all `""` ("Sem raia").
 *
 * Existe porque uma etapa pode nascer (ou ficar) com `laneValue` que não
 * aponta para raia nenhuma — vazio numa trilha que já tem raia nomeada
 * (`FormularioDeNovaEtapa` antes desta correção, ou um registro antigo do
 * banco), ou apontando para uma raia renomeada/removida. O BUG REAL
 * (relatado pelo usuário): banco com 1 raia "Estudos" e 4 etapas com
 * `laneValue` NULL/vazio — sem este agrupamento elas não casavam com
 * NENHUMA faixa e desapareciam do canvas inteiro, sem nenhum caminho na
 * interface para resgatá-las (o cartão, único lugar com o seletor "Mover
 * para raia", nunca chegava a ser desenhado).
 */
export function laneEfetivaDaEtapa(etapa: EtapaDaTrilha, raias: RaiaDaTrilha[]): string {
  if (raias.length === 0) return etapa.laneValue; // TRL-014: sem contrato de raia, nada é "órfão" — cada laneValue distinto já é a própria faixa.
  return laneReconhecida(etapa.laneValue, raias) ? etapa.laneValue : "";
}

/**
 * A mesma ordem/normalização de raias usada pelo layout — extraída para
 * `cores-de-raia.ts` também poder atribuir cor por índice sem duplicar (e
 * arriscar divergir) a regra de agrupamento por `laneValue` quando `raias`
 * vem vazio, e para `TrilhaCanvas.tsx` gerar a MESMA lista de faixas que
 * `calcularLayoutDaTrilha` usou (o zip por índice em `construirNos`).
 *
 * Quando `raias` não vem vazio mas alguma etapa é órfã (`laneEfetivaDaEtapa`
 * cai em `""` sem que já exista uma raia real com esse `laneValue`), uma
 * faixa sintética "Sem raia" é ACRESCENTADA ao fim — nunca substitui as
 * raias reais, e é só uma se houver qualquer quantidade de etapas órfãs
 * (Camada 1 do conserto do bug relatado pelo usuário).
 */
export function ordenarRaiasParaExibicao(etapas: EtapaDaTrilha[], raias: RaiaDaTrilha[]): RaiaDaTrilha[] {
  if (raias.length === 0) {
    return [...new Set(etapas.map((etapa) => etapa.laneValue))].sort().map((laneValue) => raiaSintetica(laneValue, laneValue));
  }

  const ordenadas = [...raias].sort((a, b) => a.position.localeCompare(b.position));
  const jaTemFaixaSemRaia = raias.some((raia) => raia.laneValue === "");
  const temEtapaOrfa = etapas.some((etapa) => !laneReconhecida(etapa.laneValue, raias));
  if (jaTemFaixaSemRaia || !temEtapaOrfa) return ordenadas;

  return [...ordenadas, raiaSintetica("", "")];
}

/**
 * Calcula onde cada etapa e cada raia caem no canvas. Nenhuma sobreposição
 * entre etapas (mesmo nível de uma raia nunca compartilha linha; raias
 * diferentes ocupam faixas verticais disjuntas), coluna sempre igual a
 * `etapa.level`, e toda etapa de uma raia cai dentro da faixa dela.
 *
 * INVARIANTE (não negociável, coberto em `layout.test.ts`): toda etapa que
 * entra sai posicionada — `resultado.posicoes.size === etapas.length`,
 * sempre. `raias` decide a ORDEM das faixas (por `.position`) e cobre dois
 * casos onde uma etapa não teria faixa "natural": TRL-014 (`raias` vem
 * vazio — a função não confia cegamente no contrato e agrupa pelo próprio
 * `laneValue`, uma faixa sintética por valor distinto) e a etapa ÓRFÃ (tem
 * raia real no contrato, mas `laneValue` dela não bate com nenhuma —
 * `laneEfetivaDaEtapa` cai no catch-all "Sem raia" via `ordenarRaiasParaExibicao`).
 * Este segundo caso é o bug relatado pelo usuário: sem ele, a etapa fica
 * fora de toda faixa e some do canvas — visível só no cabeçalho ("0 de N
 * concluídas"), sem nenhum jeito de resgatá-la pela interface.
 */
export function calcularLayoutDaTrilha(
  etapas: EtapaDaTrilha[],
  flechas: FlechaDaTrilha[],
  raias: RaiaDaTrilha[],
): ResultadoDoLayout {
  const posicoes = new Map<string, PosicaoDaEtapa>();
  const faixas: FaixaDaRaia[] = [];

  const raiasOrdenadas = ordenarRaiasParaExibicao(etapas, raias);

  const totalNiveis = etapas.length === 0 ? 1 : Math.max(...etapas.map((etapa) => etapa.level)) + 1;
  const largura = totalNiveis * PASSO_COLUNA;

  let cursorY = NIVEL_ROTULO_ALTURA;

  for (const raia of raiasOrdenadas) {
    const etapasDaRaia = etapas.filter((etapa) => laneEfetivaDaEtapa(etapa, raias) === raia.laneValue);

    if (raia.isCollapsed) {
      const altura = RAIA_CABECALHO_ALTURA;
      faixas.push({ laneValue: raia.laneValue, y: cursorY, height: altura, isCollapsed: true });
      for (const etapa of etapasDaRaia) {
        posicoes.set(etapa.id, { x: etapa.level * PASSO_COLUNA + GAP_COLUNA / 2, y: cursorY, width: ETAPA_LARGURA, height: ETAPA_ALTURA_MIN, visivel: false });
      }
      cursorY += altura;
      continue;
    }

    const linhaDaEtapa = atribuirLinhas(etapasDaRaia, flechas);
    const totalLinhas = linhaDaEtapa.size === 0 ? 0 : Math.max(...linhaDaEtapa.values()) + 1;
    // Cada linha mede o cartão mais alto que ela carrega (`alturaEstimadaDaEtapa`):
    // uma linha só de cartões comuns continua nos 60px de sempre, e uma com
    // um cartão de "caminho descartado" cresce o bastante para a linha de
    // baixo não nascer em cima dele.
    const alturaPorLinha = Array.from({ length: totalLinhas }, () => ETAPA_ALTURA_MIN);
    for (const etapa of etapasDaRaia) {
      const linha = linhaDaEtapa.get(etapa.id) ?? 0;
      alturaPorLinha[linha] = Math.max(alturaPorLinha[linha] ?? ETAPA_ALTURA_MIN, alturaEstimadaDaEtapa(etapa, flechas));
    }
    // Corpo da raia: uma folga (`GAP_LINHA`) acima da primeira linha e abaixo
    // da última, mais `GAP_LINHA` entre cada par de linhas — DESIGN-TRILHA.md
    // §7 ("gap entre raias"). Raia sem etapa nenhuma (TRL-014, trilha nova)
    // ainda reserva uma linha de altura, para a faixa aparecer com corpo
    // visível em vez de virar só o cabeçalho.
    const linhasParaAltura = Math.max(totalLinhas, 1);
    const somaDasLinhas = totalLinhas === 0 ? ETAPA_ALTURA_MIN : alturaPorLinha.reduce((soma, altura) => soma + altura, 0);
    const alturaCorpo = somaDasLinhas + (linhasParaAltura + 1) * GAP_LINHA;
    const altura = RAIA_CABECALHO_ALTURA + alturaCorpo;

    faixas.push({ laneValue: raia.laneValue, y: cursorY, height: altura, isCollapsed: false });

    // `y` de cada linha = soma das linhas acima dela (cada uma com o próprio gap).
    const topoDaLinha: number[] = [];
    let acumulado = cursorY + RAIA_CABECALHO_ALTURA + GAP_LINHA;
    for (const alturaDaLinha of alturaPorLinha) {
      topoDaLinha.push(acumulado);
      acumulado += alturaDaLinha + GAP_LINHA;
    }

    for (const etapa of etapasDaRaia) {
      const linha = linhaDaEtapa.get(etapa.id) ?? 0;
      const x = etapa.level * PASSO_COLUNA + GAP_COLUNA / 2;
      const y = topoDaLinha[linha] ?? cursorY + RAIA_CABECALHO_ALTURA + GAP_LINHA;
      posicoes.set(etapa.id, { x, y, width: ETAPA_LARGURA, height: alturaPorLinha[linha] ?? ETAPA_ALTURA_MIN, visivel: true });
    }

    cursorY += altura;
  }

  return { posicoes, faixas, totalNiveis, largura, altura: cursorY };
}
