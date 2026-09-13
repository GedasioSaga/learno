import type { ReactNode } from "react";
import { ColunaDoDia } from "../features/cronograma/ColunaDoDia";
import { GradeSemanal } from "../features/cronograma/GradeSemanal";
import { useCronogramaStore } from "../features/cronograma/store";
import { GradeDeLivros } from "../features/biblioteca/GradeDeLivros";
import { ConteudoDeMapaMental, useMapaMentalStore, type ArestaDoMapa, type NoDoMapa } from "../features/mapa-mental";
import { layoutRadial } from "../features/mapa-mental/layout-radial";
import { useCartoesStore } from "../features/cartoes/store";
import { usePageTreeStore } from "../features/pages/store";
import { ConteudoDeTrilha } from "../features/trilha";
import { useTrilhaStore } from "../features/trilha/store";
import { capaDeFixture } from "./capa-de-fixture";
import type {
  AtividadeDoBloco,
  BlocoPlanejado,
  CorDeMateria,
  Decisao,
  DeckCounts,
  DeckRow,
  DiaDaSemana,
  EtapaDaTrilha,
  FlechaDaTrilha,
  FormatoDeLivro,
  LivroNaEstante,
  MaterialDaEtapa,
  Materia,
  PageRow,
  ProgressoDeLeitura,
  RaiaDaTrilha,
  SemanaDeEstudo,
  SituacaoNoCaminho,
  Trilha,
} from "../lib/ipc";

/**
 * Registry de cenários da vitrine (`src/vitrine/index.tsx` monta a partir
 * daqui). Cada cenário é `{ titulo, render }` — `render` devolve o JSX já
 * pronto para a tela cheia da vitrine, sem `<Provider>` nenhum: os
 * componentes de feature leem zustand direto do módulo, e cada `render`
 * aqui popula a store ANTES de devolver o JSX (não num `useEffect`) sempre
 * que o componente dispara uma busca de IPC na montagem — é essa ordem que
 * evita a chamada real (ver o comentário de `cronograma-grade` abaixo).
 *
 * Para adicionar um cenário novo: leia o componente de feature que ele vai
 * montar, descubra se ele lê alguma store — se ler, veja se essa store tem
 * uma busca automática no `useEffect` de montagem (`carregarX`/`load`) e,
 * se tiver, popule o campo de "já carregado" (o `xStatus: "ready"` da store)
 * ANTES do JSX, do jeito que `cronograma-grade` faz. Se o componente só lê
 * de props, nem isso é preciso — é o caso de `cronograma-colunas` e
 * `biblioteca-estante` abaixo.
 */
export interface Cenario {
  titulo: string;
  render: () => ReactNode;
}

const CRIADO_EM = "2026-08-01T12:00:00.000Z";

/* =========================================================================
 * Matérias — mesma paleta de `CORES_DA_GRADE` (`features/cronograma/cores.ts`),
 * seis das oito cores para o requisito de "5-6 matérias com cores diferentes".
 * ========================================================================= */
function materia(id: string, name: string, color: CorDeMateria): Materia {
  return { id, name, color, createdAt: CRIADO_EM, updatedAt: CRIADO_EM };
}

const MATERIAS_FIXTURE: Materia[] = [
  materia("materia-matematica", "Matemática", "amber"),
  materia("materia-quimica", "Química", "mint"),
  materia("materia-historia", "História", "azul"),
  materia("materia-redacao", "Redação", "terracotta"),
  materia("materia-ingles", "Inglês", "roxo"),
  materia("materia-biologia", "Biologia", "emerald"),
];

/* =========================================================================
 * Semana densa do Cronograma — 18 blocos ao longo dos sete dias:
 * - conflito de horário (lanes): terça (09:00–09:50 x 09:30–10:15) e
 *   sábado (10:00–10:50 x 10:15–11:00);
 * - bloco que atravessa a meia-noite: quinta, 23:30 + 45min;
 * - blocos sem horário definido: segunda, quarta, sexta e domingo.
 * ========================================================================= */
interface OverridesDoBloco {
  id: string;
  localDate: string;
  activity: AtividadeDoBloco;
  plannedMinutes: number;
  subjectId: string;
  startLocalTime?: string;
  endLocalTime?: string;
  crossesMidnight?: boolean;
  title?: string;
}

function bloco(overrides: OverridesDoBloco): BlocoPlanejado {
  return {
    id: overrides.id,
    localDate: overrides.localDate,
    position: "a0",
    startLocalTime: overrides.startLocalTime ?? null,
    plannedMinutes: overrides.plannedMinutes,
    activity: overrides.activity,
    pomodoroCycles: null,
    title: overrides.title ?? null,
    deckId: null,
    pageId: null,
    subjectId: overrides.subjectId,
    createdAt: CRIADO_EM,
    updatedAt: CRIADO_EM,
    endLocalTime: overrides.endLocalTime ?? null,
    crossesMidnight: overrides.crossesMidnight ?? false,
  };
}

const M = {
  matematica: "materia-matematica",
  quimica: "materia-quimica",
  historia: "materia-historia",
  redacao: "materia-redacao",
  ingles: "materia-ingles",
  biologia: "materia-biologia",
};

const SEGUNDA = "2026-09-07";
const TERCA = "2026-09-08";
const QUARTA = "2026-09-09";
const QUINTA = "2026-09-10";
const SEXTA = "2026-09-11";
const SABADO = "2026-09-12";
const DOMINGO = "2026-09-13";

const DIAS_FIXTURE: DiaDaSemana[] = [
  {
    data: SEGUNDA,
    minutosRealizados: 90,
    blocos: [
      bloco({
        id: "bloco-1",
        localDate: SEGUNDA,
        activity: "pomodoro",
        plannedMinutes: 50,
        subjectId: M.matematica,
        startLocalTime: "08:00",
        endLocalTime: "08:50",
      }),
      bloco({
        id: "bloco-2",
        localDate: SEGUNDA,
        activity: "review",
        plannedMinutes: 40,
        subjectId: M.quimica,
        startLocalTime: "10:00",
        endLocalTime: "10:40",
      }),
      bloco({
        id: "bloco-3",
        localDate: SEGUNDA,
        activity: "reading",
        plannedMinutes: 30,
        subjectId: M.ingles,
        title: "Vocabulário - unidade 4",
      }),
    ],
  },
  {
    data: TERCA,
    minutosRealizados: 60,
    blocos: [
      // Conflito de horário: os dois blocos abaixo se sobrepõem entre
      // 09:30 e 09:50 — é o par que exercita as lanes lado a lado da Grade.
      bloco({
        id: "bloco-4",
        localDate: TERCA,
        activity: "pomodoro",
        plannedMinutes: 50,
        subjectId: M.historia,
        startLocalTime: "09:00",
        endLocalTime: "09:50",
      }),
      bloco({
        id: "bloco-5",
        localDate: TERCA,
        activity: "other",
        plannedMinutes: 45,
        subjectId: M.redacao,
        startLocalTime: "09:30",
        endLocalTime: "10:15",
      }),
      bloco({
        id: "bloco-6",
        localDate: TERCA,
        activity: "review",
        plannedMinutes: 40,
        subjectId: M.biologia,
        startLocalTime: "14:00",
        endLocalTime: "14:40",
      }),
    ],
  },
  {
    data: QUARTA,
    minutosRealizados: 75,
    blocos: [
      bloco({
        id: "bloco-7",
        localDate: QUARTA,
        activity: "pomodoro",
        plannedMinutes: 50,
        subjectId: M.matematica,
        startLocalTime: "08:00",
        endLocalTime: "08:50",
      }),
      // Encosta no fim do bloco anterior (08:50) sem sobrepor — mesma lane.
      bloco({
        id: "bloco-8",
        localDate: QUARTA,
        activity: "pomodoro",
        plannedMinutes: 25,
        subjectId: M.ingles,
        startLocalTime: "08:50",
        endLocalTime: "09:15",
      }),
      bloco({
        id: "bloco-9",
        localDate: QUARTA,
        activity: "mindmap",
        plannedMinutes: 35,
        subjectId: M.quimica,
      }),
    ],
  },
  {
    data: QUINTA,
    minutosRealizados: 45,
    blocos: [
      // Atravessa a meia-noite: 23:30 + 45min = 00:15 do dia seguinte.
      bloco({
        id: "bloco-10",
        localDate: QUINTA,
        activity: "pomodoro",
        plannedMinutes: 45,
        subjectId: M.redacao,
        startLocalTime: "23:30",
        endLocalTime: "00:15",
        crossesMidnight: true,
      }),
      bloco({
        id: "bloco-11",
        localDate: QUINTA,
        activity: "review",
        plannedMinutes: 40,
        subjectId: M.historia,
        startLocalTime: "16:00",
        endLocalTime: "16:40",
      }),
    ],
  },
  {
    data: SEXTA,
    minutosRealizados: 120,
    blocos: [
      bloco({
        id: "bloco-12",
        localDate: SEXTA,
        activity: "pomodoro",
        plannedMinutes: 50,
        subjectId: M.biologia,
        startLocalTime: "07:30",
        endLocalTime: "08:20",
      }),
      bloco({
        id: "bloco-13",
        localDate: SEXTA,
        activity: "review",
        plannedMinutes: 40,
        subjectId: M.matematica,
        startLocalTime: "12:00",
        endLocalTime: "12:40",
      }),
      bloco({
        id: "bloco-14",
        localDate: SEXTA,
        activity: "other",
        plannedMinutes: 60,
        subjectId: M.ingles,
        title: "Redação de ensaio - rascunho",
      }),
    ],
  },
  {
    data: SABADO,
    minutosRealizados: 30,
    blocos: [
      // Segundo conflito de horário da semana: sobreposição 10:15–10:50.
      bloco({
        id: "bloco-15",
        localDate: SABADO,
        activity: "pomodoro",
        plannedMinutes: 50,
        subjectId: M.quimica,
        startLocalTime: "10:00",
        endLocalTime: "10:50",
      }),
      bloco({
        id: "bloco-16",
        localDate: SABADO,
        activity: "pomodoro",
        plannedMinutes: 45,
        subjectId: M.historia,
        startLocalTime: "10:15",
        endLocalTime: "11:00",
      }),
    ],
  },
  {
    data: DOMINGO,
    minutosRealizados: 0,
    blocos: [
      bloco({
        id: "bloco-17",
        localDate: DOMINGO,
        activity: "review",
        plannedMinutes: 40,
        subjectId: M.redacao,
        startLocalTime: "18:00",
        endLocalTime: "18:40",
      }),
      bloco({
        id: "bloco-18",
        localDate: DOMINGO,
        activity: "other",
        plannedMinutes: 30,
        subjectId: M.biologia,
      }),
    ],
  },
];

const SEMANA_FIXTURE: SemanaDeEstudo = {
  inicio: SEGUNDA,
  metaMinutos: 600,
  dias: DIAS_FIXTURE,
};

/* =========================================================================
 * Biblioteca — 12 livros com capa/sem capa e progresso variado.
 * ========================================================================= */

/**
 * A capa ficticia de cada livro vem de `capa-de-fixture.ts` - uma capa
 * distinta por id, em vez da mesma capa marrom para todos. O motivo esta
 * documentado la: capa repetida faz a estante parecer monotona por culpa da
 * fixture, e esconde a diferenca entre capa real e a capa sintetica que
 * `LivroCard` gera quando `coverFileName` e nulo.
 */

interface OverridesDoLivro {
  id: string;
  titulo: string;
  autor: string | null;
  formato: FormatoDeLivro;
  comCapa: boolean;
  status: ProgressoDeLeitura["status"];
  fracao: number;
}

function livroNaEstante(overrides: OverridesDoLivro): LivroNaEstante {
  const { id, titulo, autor, formato, comCapa, status, fracao } = overrides;
  return {
    livro: {
      id,
      pageId: `${id}-pagina`,
      format: formato,
      contentHash: `hash-${id}`,
      fileName: `${id}.${formato}`,
      originalFileName: `${titulo}.${formato}`,
      fileSize: 2_400_000,
      coverFileName: comCapa ? capaDeFixture(id, titulo, autor) : null,
      metadataTitle: titulo,
      metadataAuthor: autor,
      position: "a0",
      totalUnits: 320,
      // Sem base real para checar camada de texto num PDF de fixture —
      // `null` é o estado honesto ("ninguém checou"), não `false`.
      hasTextLayer: formato === "pdf" ? null : null,
      createdAt: CRIADO_EM,
      updatedAt: CRIADO_EM,
    },
    progresso: {
      bookId: id,
      currentLocator: fracao > 0 ? "loc-atual" : null,
      currentFraction: fracao,
      furthestLocator: fracao > 0 ? "loc-mais-distante" : null,
      furthestFraction: fracao,
      status,
      lastReadAt: fracao > 0 ? CRIADO_EM : null,
      finishedAt: status === "finished" ? CRIADO_EM : null,
      updatedAt: CRIADO_EM,
    },
    titulo,
    autor,
  };
}

const LIVROS_FIXTURE: LivroNaEstante[] = [
  livroNaEstante({
    id: "livro-1",
    titulo: "Dom Casmurro",
    autor: "Machado de Assis",
    formato: "epub",
    comCapa: true,
    status: "finished",
    fracao: 1,
  }),
  livroNaEstante({
    id: "livro-2",
    titulo: "A Hora da Estrela",
    autor: "Clarice Lispector",
    formato: "epub",
    comCapa: false,
    status: "finished",
    fracao: 0.92,
  }),
  livroNaEstante({
    id: "livro-3",
    titulo: "Grande Sertão: Veredas",
    autor: "Guimarães Rosa",
    formato: "pdf",
    comCapa: true,
    status: "reading",
    fracao: 0.47,
  }),
  livroNaEstante({
    id: "livro-4",
    titulo: "Memórias Póstumas de Brás Cubas",
    autor: "Machado de Assis",
    formato: "epub",
    comCapa: true,
    status: "reading",
    fracao: 0.63,
  }),
  livroNaEstante({
    id: "livro-5",
    titulo: "Vidas Secas",
    autor: null,
    formato: "pdf",
    comCapa: false,
    status: "unread",
    fracao: 0,
  }),
  livroNaEstante({
    id: "livro-6",
    titulo: "O Cortiço",
    autor: "Aluísio Azevedo",
    formato: "epub",
    comCapa: true,
    status: "reading",
    fracao: 0.28,
  }),
  livroNaEstante({
    id: "livro-7",
    titulo: "Iracema",
    autor: "José de Alencar",
    formato: "pdf",
    comCapa: false,
    status: "unread",
    fracao: 0,
  }),
  livroNaEstante({
    id: "livro-8",
    titulo: "Capitães da Areia",
    autor: "Jorge Amado",
    formato: "epub",
    comCapa: true,
    status: "finished",
    fracao: 1,
  }),
  livroNaEstante({
    id: "livro-9",
    titulo: "Sagarana",
    autor: null,
    formato: "pdf",
    comCapa: false,
    status: "reading",
    fracao: 0.15,
  }),
  livroNaEstante({
    id: "livro-10",
    titulo: "O Alienista",
    autor: "Machado de Assis",
    formato: "epub",
    comCapa: true,
    status: "unread",
    fracao: 0,
  }),
  livroNaEstante({
    id: "livro-11",
    titulo: "Quincas Borba",
    autor: "Machado de Assis",
    formato: "pdf",
    comCapa: false,
    status: "reading",
    fracao: 0.71,
  }),
  livroNaEstante({
    id: "livro-12",
    titulo: "Triste Fim de Policarpo Quaresma",
    autor: "Lima Barreto",
    formato: "epub",
    comCapa: true,
    status: "reading",
    fracao: 0.38,
  }),
];

/* =========================================================================
 * Mapa mental — árvore sintética com ramificação realista (raiz → alguns
 * ramos de primeiro nível → subárvores de profundidade 3-4), para medir a
 * fluidez do arrasto num navegador de verdade (`mapa-mental-50/200/500`
 * abaixo). `layoutRadial` (`features/mapa-mental/layout-radial.ts`, a mesma
 * função que o botão "Organizar" do app usa) é quem decide a POSIÇÃO na
 * tela; a geração aqui só decide quem é filho de quem.
 * ========================================================================= */

/** Ramos de primeiro nível — nomes de matéria, sem repetir entre si
 *  (diferente dos níveis mais fundos, que ciclam um pool pequeno e podem
 *  repetir — do jeito que notas reais de estudo repetem palavras como
 *  "Exemplo" ou "Resumo"). */
const RAMOS_DE_PRIMEIRO_NIVEL = ["Matemática", "Química", "Biologia", "História", "Redação", "Inglês", "Geografia"];

/** Textos curtos por profundidade (2 a 5), como um array indexado por
 *  `profundidade - 2` — mais simples que `Record<number, string[]>` porque
 *  não deixa `undefined` entrar no tipo (o índice sempre cai dentro do
 *  array por construção: `gerarArvoreMapaMental` nunca cria nó além da
 *  profundidade 5). */
const TEXTOS_POR_PROFUNDIDADE: readonly (readonly string[])[] = [
  ["Conceito central", "Subtema", "Tópico relacionado", "Ideia secundária", "Ramo de estudo"], // profundidade 2
  ["Exemplo prático", "Fórmula", "Definição", "Aplicação", "Erro comum"], // profundidade 3
  ["Detalhe", "Anotação rápida", "Dúvida", "Exercício", "Dica de prova"], // profundidade 4
  ["Resumo", "Data importante", "Palavra-chave", "Observação", "Revisão"], // profundidade 5
];

/** Profundidade máxima da árvore (raiz = 0) — dá até 4 níveis de subárvore
 *  sob cada ramo de primeiro nível (profundidade 2 a 5), o "3-4" pedido no
 *  briefing contando a partir do ramo. */
const PROFUNDIDADE_MAXIMA = 5;

/** Quantos ramos de primeiro nível a raiz ganha — cresce bem mais devagar
 *  que o total de nós (um mapa mental de verdade cresce em PROFUNDIDADE
 *  conforme fica maior, não em largura no topo): é o que evita a "estrela
 *  degenerada" pedida no briefing mesmo em `mapa-mental-500`. */
function numeroDeRamos(totalDeNos: number): number {
  return Math.min(RAMOS_DE_PRIMEIRO_NIVEL.length, Math.max(3, Math.floor(totalDeNos / 12)));
}

/** Ramificação de um nó a partir da profundidade 2 em diante — cicla 2, 3 e
 *  4 filhos pela ordem de criação (BFS), então nenhum nó fica com um único
 *  filho (isso degeneraria numa linha reta) nem com dezenas de filhos (isso
 *  degeneraria numa estrela). */
function ramificacao(indiceNaFila: number): number {
  return 2 + (indiceNaFila % 3);
}

interface NoGerado {
  id: string;
  pai: string | null;
  profundidade: number;
}

function textoDoNo(gerado: NoGerado, indice: number): string {
  if (gerado.profundidade === 0) return "Como estudar bem";
  if (gerado.profundidade === 1) return RAMOS_DE_PRIMEIRO_NIVEL[indice % RAMOS_DE_PRIMEIRO_NIVEL.length];
  const pool = TEXTOS_POR_PROFUNDIDADE[gerado.profundidade - 2];
  return pool[indice % pool.length];
}

/**
 * Gera `totalDeNos` nós em árvore por BFS: a raiz, `numeroDeRamos` filhos
 * diretos (os "ramos"), e daí em diante cada nó tirado da fila ganha de 2 a
 * 4 filhos (`ramificacao`) até a profundidade máxima ou até o total pedido
 * acabar — o que vier primeiro. BFS (fila, não pilha) é o que garante uma
 * árvore larga E funda ao mesmo tempo: uma pilha esgotaria a profundidade de
 * um ramo inteiro antes de sequer tocar o próximo, virando uma linha reta
 * disfarçada de árvore.
 */
function gerarArvoreMapaMental(totalDeNos: number): { nos: NoDoMapa[]; arestas: ArestaDoMapa[] } {
  const raiz: NoGerado = { id: "no-0", pai: null, profundidade: 0 };
  const gerados: NoGerado[] = [raiz];
  const fila: NoGerado[] = [];

  const qtdRamos = Math.min(numeroDeRamos(totalDeNos), totalDeNos - 1);
  for (let i = 0; i < qtdRamos; i++) {
    const no: NoGerado = { id: `no-${gerados.length}`, pai: raiz.id, profundidade: 1 };
    gerados.push(no);
    fila.push(no);
  }

  let indiceDeRamificacao = 0;
  while (fila.length > 0 && gerados.length < totalDeNos) {
    // shift() nunca retorna undefined aqui: o laço só continua com length > 0.
    const atual = fila.shift()!;
    if (atual.profundidade >= PROFUNDIDADE_MAXIMA) continue;
    const qtdFilhos = Math.min(ramificacao(indiceDeRamificacao++), totalDeNos - gerados.length);
    for (let i = 0; i < qtdFilhos; i++) {
      const filho: NoGerado = { id: `no-${gerados.length}`, pai: atual.id, profundidade: atual.profundidade + 1 };
      gerados.push(filho);
      fila.push(filho);
    }
  }

  const nos: NoDoMapa[] = gerados.map((gerado, indice) => ({
    id: gerado.id,
    type: "cartaoMental",
    // Posição provisória — `layoutRadial`, chamado logo depois desta função
    // no `render` do cenário, substitui isto por uma posição de verdade
    // antes do primeiro paint.
    position: { x: 0, y: 0 },
    data: { label: textoDoNo(gerado, indice) },
  }));

  const arestas: ArestaDoMapa[] = gerados
    .filter((gerado): gerado is NoGerado & { pai: string } => gerado.pai !== null)
    .map((gerado) => ({ id: `aresta-${gerado.id}`, source: gerado.pai, target: gerado.id }));

  return { nos, arestas };
}

/**
 * Monta um cenário `mapa-mental-N`: gera a árvore, calcula o layout radial
 * (mesma função que o botão "Organizar" do app usa) e popula
 * `useMapaMentalStore` com o resultado ANTES do `return` do JSX — mesmo
 * padrão de `cronograma-grade` acima. `ConteudoDeMapaMental`/`CanvasDoMapa`
 * não têm nenhum `useEffect` que dispare IPC na montagem (só ações do
 * usuário — clique, tecla — chamam a store; ver `store.ts`), então aqui não
 * há a corrida "efeito do filho roda antes do pai" que `cronograma-grade`
 * evita; ainda assim popular antes do JSX é o padrão deste arquivo.
 *
 * `ConteudoDeMapaMental` não empacota o próprio canvas num container com
 * altura definida (`h-full w-full` — depende do pai) — por isso o `<div>`
 * abaixo fixa `h-screen`, senão o `@xyflow/react` mede um contêiner de
 * altura zero.
 */
function cenarioDeMapaMental(totalDeNos: number): Cenario {
  return {
    titulo: `Mapa mental — ${totalDeNos} nós`,
    render: () => {
      const { nos: nosSemPosicao, arestas } = gerarArvoreMapaMental(totalDeNos);
      const posicoes = layoutRadial(nosSemPosicao, arestas);
      const nos = nosSemPosicao.map((no) => ({ ...no, position: posicoes.get(no.id) ?? no.position }));

      useMapaMentalStore.setState({
        mapaAtivoId: "mapa-vitrine",
        statusGrafo: "ready",
        errorMessage: null,
        nos,
        arestas,
      });

      return (
        <div data-vitrine-nos={totalDeNos} className="h-screen">
          <ConteudoDeMapaMental />
        </div>
      );
    },
  };
}

/* =========================================================================
 * Trilha — três cenários (pequena/média/com decisão), cada um uma trilha de
 * estudo REAL (matérias/etapas com nome de verdade, nunca "Etapa 1/2/3").
 *
 * Diferente do mapa mental (só `nós`/`arestas`, sem grafo de dependência),
 * aqui `level`/`isUnlocked`/`inCycle`/`situacaoNoCaminho` são campos que o
 * BACKEND calcularia a partir do grafo (`src-tauri/src/db/trilha.rs`) — a
 * fixture precisa escrevê-los já resolvidos, à mão, em vez de só listar
 * flechas e esperar algo aqui recalcular (não há esse "algo": `layout.ts` só
 * decide POSIÇÃO a partir de `level`/`laneValue`, nunca desbloqueio).
 * ========================================================================= */

/**
 * Contador de posição fracionária da vitrine — cada chamada a `etapaDeTrilha`
 * pega a próxima, na ORDEM DO CÓDIGO-FONTE (a mesma ordem em que cada fixture
 * já lista as etapas). Simula o índice fracionário real de `pages.position`:
 * zero-padded para todo string ter o mesmo comprimento, e por isso
 * comparável por `localeCompare` puro — igual ao que `layout.ts` faz com o
 * campo de verdade. Contador único para o módulo inteiro (não por trilha):
 * inofensivo, porque `position` só desempata dentro do MESMO nível da MESMA
 * raia da MESMA trilha, e a ordem de declaração já é monotônica aí.
 */
let proximaPosicaoDaVitrine = 0;
function posicaoDaVitrine(): string {
  return `p${String(proximaPosicaoDaVitrine++).padStart(5, "0")}`;
}

/**
 * Uma etapa da fixture — `state` decide `startedAt`/`completedAt` sozinho
 * (nunca concluída sem `startedAt`, nunca em andamento com `completedAt`), e
 * `isUnlocked` default é `state !== null` (quem já começou ou terminou por
 * definição já estava desbloqueada) — só as etapas com `state: null` LIDAS
 * como "disponível" precisam do `{ isUnlocked: true }` explícito; o default
 * `false` já cobre "bloqueada".
 */
function etapaDeTrilha(
  id: string,
  title: string,
  laneValue: string,
  level: number,
  opcoes: {
    state?: "in_progress" | "done" | null;
    isUnlocked?: boolean;
    inCycle?: boolean;
    situacaoNoCaminho?: SituacaoNoCaminho;
  } = {},
): EtapaDaTrilha {
  const state = opcoes.state ?? null;
  return {
    id,
    title,
    icon: null,
    laneValue,
    position: posicaoDaVitrine(),
    level,
    inCycle: opcoes.inCycle ?? false,
    isUnlocked: opcoes.isUnlocked ?? state !== null,
    situacaoNoCaminho: opcoes.situacaoNoCaminho ?? "ativo",
    state,
    startedAt: state !== null ? CRIADO_EM : null,
    completedAt: state === "done" ? CRIADO_EM : null,
  };
}

/** `pathLabel` só quando `blockingId` é uma decisão (contrato de `FlechaDaTrilha`) — `null` é pré-requisito incondicional. */
function flechaDeTrilha(blockedId: string, blockingId: string, pathLabel: string | null = null): FlechaDaTrilha {
  return { blockedId, blockingId, pathLabel };
}

function raiaDeTrilha(laneValue: string, position: string): RaiaDaTrilha {
  return { viewId: "trilha-vitrine", laneValue, position, isCollapsed: false, createdAt: CRIADO_EM, updatedAt: CRIADO_EM };
}

function materialDeTrilha(id: string, stepId: string, kind: "page" | "deck", pageId: string | null, deckId: string | null): MaterialDaEtapa {
  return { id, stepId, kind, pageId, deckId, position: "a0", createdAt: CRIADO_EM };
}

function decisaoDeTrilha(stepId: string, chosenLabel: string | null): Decisao {
  return { stepId, chosenLabel, chosenAt: chosenLabel !== null ? CRIADO_EM : null, createdAt: CRIADO_EM, updatedAt: CRIADO_EM };
}

function paginaDeTrilha(id: string, title: string): PageRow {
  return {
    id,
    parent_id: null,
    database_id: null,
    title,
    icon: null,
    position: "a0",
    is_favorite: false,
    deleted_at: null,
    created_at: CRIADO_EM,
    updated_at: CRIADO_EM,
  };
}

function baralhoDeTrilha(id: string, name: string): DeckRow {
  return { id, parentId: null, name, options: null, position: "a0", deletedAt: null, createdAt: CRIADO_EM, updatedAt: CRIADO_EM };
}

/**
 * Pool compartilhado de página/baralho — as três trilhas abaixo anexam
 * material a partir daqui (`EtapaNode.tsx` resolve `pageId`/`deckId` contra
 * `usePageTreeStore`/`useCartoesStore`, nunca contra `trilha.materiais`
 * sozinho: sem isto o cartão mostraria só o fallback genérico "Página"/
 * "Baralho" em vez do título de verdade).
 */
const PAGINAS_DA_TRILHA_FIXTURE: PageRow[] = [
  paginaDeTrilha("pagina-genetica-slides", "Genética — slides da aula"),
  paginaDeTrilha("pagina-constituicao-resumo", "Constituição Federal — resumo"),
  paginaDeTrilha("pagina-vocabulario-certificacao", "Lista de vocabulário — TOEFL/IELTS"),
];
const BARALHOS_DA_TRILHA_FIXTURE: DeckRow[] = [
  baralhoDeTrilha("baralho-leis-mendel", "Leis de Mendel"),
  baralhoDeTrilha("baralho-raciocinio-logico", "Raciocínio lógico"),
  baralhoDeTrilha("baralho-phrasal-verbs", "Phrasal verbs"),
];
const PAGINAS_POR_ID_DA_TRILHA_FIXTURE = new Map(PAGINAS_DA_TRILHA_FIXTURE.map((pagina) => [pagina.id, pagina] as const));
const BARALHOS_POR_ID_DA_TRILHA_FIXTURE = new Map(BARALHOS_DA_TRILHA_FIXTURE.map((baralho) => [baralho.id, baralho] as const));
const CONTAGENS_DOS_BARALHOS_DA_TRILHA_FIXTURE = new Map<string | null, DeckCounts>([
  ["baralho-leis-mendel", { novos: 4, aprendendo: 2, revisar: 3 }],
  ["baralho-raciocinio-logico", { novos: 6, aprendendo: 0, revisar: 5 }],
  ["baralho-phrasal-verbs", { novos: 10, aprendendo: 3, revisar: 0 }],
]);

/**
 * 8 etapas em 2 raias — trilha de estudo de Biologia (genética) para uma
 * prova, o caso pequeno: uma dependência por etapa, sem ramificação, com os
 * quatro estados de progresso mais comuns (concluída, em andamento,
 * disponível, bloqueada) e SEM ciclo — `trilha-media` cobre esse extremo.
 */
const TRILHA_PEQUENA_FIXTURE: Trilha = {
  configuracao: { viewId: "trilha-pequena", groupPropertyId: "prop-raia-vitrine", createdAt: CRIADO_EM, updatedAt: CRIADO_EM },
  raias: [raiaDeTrilha("Teoria", "a0"), raiaDeTrilha("Exercícios", "a1")],
  etapas: [
    etapaDeTrilha("tp-teoria-1", "Revisar DNA e RNA", "Teoria", 0, { state: "done" }),
    etapaDeTrilha("tp-teoria-2", "Estudar as leis de Mendel", "Teoria", 1, { state: "done" }),
    etapaDeTrilha("tp-teoria-3", "Genética de populações", "Teoria", 2, { state: "in_progress" }),
    etapaDeTrilha("tp-teoria-4", "Herança poligênica", "Teoria", 3),
    etapaDeTrilha("tp-exerc-1", "Resolver lista de exercícios 1", "Exercícios", 1, { isUnlocked: true }),
    etapaDeTrilha("tp-exerc-2", "Resolver lista de exercícios 2", "Exercícios", 2),
    etapaDeTrilha("tp-exerc-3", "Simulado parcial", "Exercícios", 3),
    etapaDeTrilha("tp-exerc-4", "Revisão final antes da prova", "Exercícios", 4),
  ],
  flechas: [
    flechaDeTrilha("tp-teoria-2", "tp-teoria-1"),
    flechaDeTrilha("tp-teoria-3", "tp-teoria-2"),
    flechaDeTrilha("tp-teoria-4", "tp-teoria-3"),
    flechaDeTrilha("tp-exerc-1", "tp-teoria-1"),
    flechaDeTrilha("tp-exerc-2", "tp-exerc-1"),
    flechaDeTrilha("tp-exerc-2", "tp-teoria-2"),
    flechaDeTrilha("tp-exerc-3", "tp-exerc-2"),
    flechaDeTrilha("tp-exerc-3", "tp-teoria-3"),
    flechaDeTrilha("tp-exerc-4", "tp-exerc-3"),
    flechaDeTrilha("tp-exerc-4", "tp-teoria-4"),
  ],
  materiais: [
    materialDeTrilha("material-tp-1", "tp-teoria-1", "page", "pagina-genetica-slides", null),
    materialDeTrilha("material-tp-2", "tp-exerc-1", "deck", null, "baralho-leis-mendel"),
  ],
  decisoes: [],
};

/**
 * 20 etapas em 4 raias — preparação para um concurso público. O caso médio:
 * ramificação DE VERDADE nos dois sentidos (uma etapa desbloqueando duas em
 * raias diferentes: `tm-dir-2` alimenta `tm-dir-3` E `tm-mat-3`; e a
 * convergência inversa, várias bloqueando uma só: `tm-red-5` junta as quatro
 * raias) mais um CICLO de propósito (`tm-mat-4`⇄`tm-mat-5`, o engano real que
 * a Trilha existe para expor em vez de esconder).
 */
const TRILHA_MEDIA_FIXTURE: Trilha = {
  configuracao: { viewId: "trilha-media", groupPropertyId: "prop-raia-vitrine", createdAt: CRIADO_EM, updatedAt: CRIADO_EM },
  raias: [
    raiaDeTrilha("Português", "a0"),
    raiaDeTrilha("Direito Constitucional", "a1"),
    raiaDeTrilha("Matemática", "a2"),
    raiaDeTrilha("Redação", "a3"),
  ],
  etapas: [
    etapaDeTrilha("tm-port-1", "Revisão de crase", "Português", 0, { state: "done" }),
    etapaDeTrilha("tm-port-2", "Concordância verbal e nominal", "Português", 1, { state: "done" }),
    etapaDeTrilha("tm-port-3", "Regência verbal e nominal", "Português", 2, { state: "in_progress" }),
    etapaDeTrilha("tm-port-4", "Interpretação de texto", "Português", 3),
    etapaDeTrilha("tm-port-5", "Redação oficial (técnica)", "Português", 4),

    etapaDeTrilha("tm-dir-1", "Princípios fundamentais", "Direito Constitucional", 0, { state: "done" }),
    etapaDeTrilha("tm-dir-2", "Direitos e garantias fundamentais", "Direito Constitucional", 1, { state: "done" }),
    etapaDeTrilha("tm-dir-3", "Organização do Estado", "Direito Constitucional", 2, { isUnlocked: true }),
    etapaDeTrilha("tm-dir-4", "Poder Legislativo", "Direito Constitucional", 3),
    etapaDeTrilha("tm-dir-5", "Controle de constitucionalidade", "Direito Constitucional", 4),

    etapaDeTrilha("tm-mat-1", "Raciocínio lógico básico", "Matemática", 0, { state: "done" }),
    etapaDeTrilha("tm-mat-2", "Porcentagem e juros", "Matemática", 1, { state: "done" }),
    etapaDeTrilha("tm-mat-3", "Análise combinatória", "Matemática", 2, { isUnlocked: true }),
    etapaDeTrilha("tm-mat-4", "Probabilidade", "Matemática", 3, { inCycle: true }),
    etapaDeTrilha("tm-mat-5", "Estatística descritiva", "Matemática", 4, { inCycle: true }),

    etapaDeTrilha("tm-red-1", "Estrutura da dissertação", "Redação", 0, { state: "done" }),
    etapaDeTrilha("tm-red-2", "Coesão e coerência", "Redação", 1, { state: "in_progress" }),
    etapaDeTrilha("tm-red-3", "Prática de redação — tema 1", "Redação", 4),
    etapaDeTrilha("tm-red-4", "Prática de redação — tema 2", "Redação", 5),
    etapaDeTrilha("tm-red-5", "Simulado geral", "Redação", 6),
  ],
  flechas: [
    flechaDeTrilha("tm-port-2", "tm-port-1"),
    flechaDeTrilha("tm-port-3", "tm-port-2"),
    flechaDeTrilha("tm-port-4", "tm-port-3"),
    flechaDeTrilha("tm-port-5", "tm-port-4"),

    flechaDeTrilha("tm-dir-2", "tm-dir-1"),
    flechaDeTrilha("tm-dir-3", "tm-dir-2"),
    flechaDeTrilha("tm-dir-4", "tm-dir-3"),
    flechaDeTrilha("tm-dir-5", "tm-dir-4"),

    flechaDeTrilha("tm-mat-2", "tm-mat-1"),
    // Ramificação: "Direitos e garantias fundamentais" (tm-dir-2) desbloqueia
    // tm-dir-3 (acima) E tm-mat-3 (aqui) — duas raias diferentes a partir da
    // MESMA etapa. tm-mat-3, por sua vez, converge tm-mat-2 e tm-dir-2.
    flechaDeTrilha("tm-mat-3", "tm-mat-2"),
    flechaDeTrilha("tm-mat-3", "tm-dir-2"),
    // Ciclo de propósito: tm-mat-4 e tm-mat-5 se bloqueiam mutuamente, então
    // nenhuma das duas desbloqueia sozinha (`inCycle: true` nas duas acima) —
    // é o caso "em-ciclo" do pedido.
    flechaDeTrilha("tm-mat-4", "tm-mat-3"),
    flechaDeTrilha("tm-mat-4", "tm-mat-5"),
    flechaDeTrilha("tm-mat-5", "tm-mat-4"),

    flechaDeTrilha("tm-red-2", "tm-red-1"),
    // Convergência cruzada: a prática de redação só desbloqueia depois da
    // coesão/coerência (Redação) E da interpretação de texto (Português).
    flechaDeTrilha("tm-red-3", "tm-red-2"),
    flechaDeTrilha("tm-red-3", "tm-port-4"),
    flechaDeTrilha("tm-red-4", "tm-red-3"),
    // Convergência final: o simulado geral junta as quatro raias.
    flechaDeTrilha("tm-red-5", "tm-red-4"),
    flechaDeTrilha("tm-red-5", "tm-dir-5"),
    flechaDeTrilha("tm-red-5", "tm-mat-5"),
    flechaDeTrilha("tm-red-5", "tm-port-5"),
  ],
  materiais: [
    materialDeTrilha("material-tm-1", "tm-dir-1", "page", "pagina-constituicao-resumo", null),
    materialDeTrilha("material-tm-2", "tm-mat-1", "deck", null, "baralho-raciocinio-logico"),
  ],
  decisoes: [],
};

/**
 * 14 etapas em 3 raias — preparação para uma certificação de inglês, com uma
 * DECISÃO de verdade (`tc-base-4`, "TOEFL" venceu): o caminho escolhido segue
 * `situacaoNoCaminho: "ativo"`, o caminho perdedor nasce `"descartado"` (a
 * etapa continua visível e na mesma coluna — nunca escondida, regra do
 * backend em `src-tauri/src/db/trilha.rs`), e "descartado" PROPAGA por
 * dependência transitiva (`tc-cert-ielts-2`, que só depende de outra etapa
 * descartada, não da decisão em si, também nasce descartada).
 */
const TRILHA_COM_DECISAO_FIXTURE: Trilha = {
  configuracao: { viewId: "trilha-com-decisao", groupPropertyId: "prop-raia-vitrine", createdAt: CRIADO_EM, updatedAt: CRIADO_EM },
  raias: [raiaDeTrilha("Base", "a0"), raiaDeTrilha("Certificação", "a1"), raiaDeTrilha("Documentação", "a2")],
  etapas: [
    etapaDeTrilha("tc-base-1", "Diagnóstico de nível inicial", "Base", 0, { state: "done" }),
    etapaDeTrilha("tc-base-2", "Vocabulário essencial", "Base", 1, { state: "done" }),
    etapaDeTrilha("tc-base-3", "Escuta e compreensão", "Base", 2, { state: "done" }),
    // A decisão: `decisoes` abaixo é o que a torna uma decisão de fato (não
    // há campo "tipo" — ver o comentário de `Decisao` em lib/ipc.ts).
    etapaDeTrilha("tc-base-4", "Escolher certificação: TOEFL ou IELTS", "Base", 3, { state: "done" }),

    etapaDeTrilha("tc-cert-toefl-1", "Estrutura da prova TOEFL", "Certificação", 4, { isUnlocked: true }),
    etapaDeTrilha("tc-cert-toefl-2", "Simulado TOEFL", "Certificação", 5),
    etapaDeTrilha("tc-cert-ielts-1", "Estrutura da prova IELTS", "Certificação", 4, { situacaoNoCaminho: "descartado" }),
    etapaDeTrilha("tc-cert-ielts-2", "Simulado IELTS", "Certificação", 5, { situacaoNoCaminho: "descartado" }),
    etapaDeTrilha("tc-cert-geral-1", "Treino de redação (Writing) — comum aos dois formatos", "Certificação", 4, { isUnlocked: true }),
    etapaDeTrilha("tc-cert-geral-2", "Revisão de vocabulário acadêmico", "Certificação", 5),

    etapaDeTrilha("tc-doc-1", "Emitir passaporte", "Documentação", 0, { state: "done" }),
    etapaDeTrilha("tc-doc-2", "Cadastro no site da aplicadora", "Documentação", 1, { state: "in_progress" }),
    etapaDeTrilha("tc-doc-3", "Pagar taxa de inscrição", "Documentação", 2),
    etapaDeTrilha("tc-doc-4", "Agendar exame", "Documentação", 6),
  ],
  flechas: [
    flechaDeTrilha("tc-base-2", "tc-base-1"),
    flechaDeTrilha("tc-base-3", "tc-base-2"),
    flechaDeTrilha("tc-base-4", "tc-base-3"),

    // Duas flechas rotuladas saindo da MESMA decisão — os dois caminhos.
    flechaDeTrilha("tc-cert-toefl-1", "tc-base-4", "TOEFL"),
    flechaDeTrilha("tc-cert-toefl-2", "tc-cert-toefl-1"),
    flechaDeTrilha("tc-cert-ielts-1", "tc-base-4", "IELTS"),
    flechaDeTrilha("tc-cert-ielts-2", "tc-cert-ielts-1"),
    // Pré-requisito INCONDICIONAL saindo de uma decisão (sem rótulo): comum
    // aos dois caminhos, não é um terceiro caminho.
    flechaDeTrilha("tc-cert-geral-1", "tc-base-4"),
    flechaDeTrilha("tc-cert-geral-2", "tc-cert-geral-1"),

    flechaDeTrilha("tc-doc-2", "tc-doc-1"),
    flechaDeTrilha("tc-doc-3", "tc-doc-2"),
    // Convergência: agendar o exame depende da parte administrativa E do
    // simulado do caminho ESCOLHIDO — nunca do descartado.
    flechaDeTrilha("tc-doc-4", "tc-doc-3"),
    flechaDeTrilha("tc-doc-4", "tc-cert-toefl-2"),
  ],
  materiais: [
    materialDeTrilha("material-tc-1", "tc-base-2", "page", "pagina-vocabulario-certificacao", null),
    materialDeTrilha("material-tc-2", "tc-cert-toefl-1", "deck", null, "baralho-phrasal-verbs"),
  ],
  decisoes: [decisaoDeTrilha("tc-base-4", "TOEFL")],
};

/**
 * Monta um cenário de Trilha — renderiza o MESMO `ConteudoDeTrilha` do app,
 * populando `useTrilhaStore` com a cena inteira ANTES do JSX (mesmo padrão
 * do resto do arquivo). Layout e cor NÃO são calculados aqui: `TrilhaCanvas`
 * já os recalcula sozinho a partir de `etapas`/`flechas`/`raias`
 * (`calcularLayoutDaTrilha`/`mapaDeCoresDasRaias`), exatamente como no app
 * real — diferente do mapa mental, que precisa do layout pronto porque não
 * tem um `TrilhaCanvas` equivalente calculando por conta própria.
 *
 * Três obstáculos de IPC-no-mount, e como cada um foi neutralizado sem tocar
 * em `src/features/`:
 * 1. `ConteudoDeTrilha` chama `carregar()` no PRÓPRIO `useEffect` de
 *    montagem, sempre — ao contrário de `carregarMaterias()` (cronograma) ou
 *    `load()` (páginas/baralhos, usados abaixo), essa ação não confere o
 *    `status` atual antes de rodar: leria `localStorage` (vazio na vitrine),
 *    acharia nada, e sobrescreveria a trilha recém-populada com
 *    `status: "vazia"` antes do primeiro paint. Como não há um "já está
 *    pronto, não recarregue" para aproveitar, a saída foi substituir a
 *    própria função por um no-op via `setState` — a mesma API pública que
 *    `store.test.ts` usa para popular a store nos testes, não uma alteração
 *    em `store.ts`.
 * 2 e 3. `TrilhaCanvas` (montado dentro de `ConteudoDeTrilha`) dispara
 *    `carregarPaginas()`/`carregarBaralhos()` (`usePageTreeStore`/
 *    `useCartoesStore`) sempre que o `status` de cada uma é `"idle"` — aqui
 *    sim há a guarda de status, então basta pré-popular as duas como
 *    `"ready"`, do jeito que `cronograma-grade` já faz com `materiasStatus`.
 */
function cenarioDeTrilha(titulo: string, trilha: Trilha): Cenario {
  return {
    titulo,
    render: () => {
      useTrilhaStore.setState({
        status: "pronta",
        viewId: trilha.configuracao.viewId,
        databaseId: "database-vitrine",
        trilha,
        mapaDeDecisoes: new Map(trilha.decisoes.map((decisao) => [decisao.stepId, decisao] as const)),
        errorMessage: null,
        carregar: async () => {},
      });
      usePageTreeStore.setState({ status: "ready", pagesById: PAGINAS_POR_ID_DA_TRILHA_FIXTURE });
      useCartoesStore.setState({
        status: "ready",
        decksById: BARALHOS_POR_ID_DA_TRILHA_FIXTURE,
        contagens: CONTAGENS_DOS_BARALHOS_DA_TRILHA_FIXTURE,
      });

      return (
        <div data-vitrine-etapas={trilha.etapas.length} className="h-screen">
          <ConteudoDeTrilha />
        </div>
      );
    },
  };
}

/* =========================================================================
 * Registry.
 * ========================================================================= */
export const CENARIOS: Record<string, Cenario> = {
  "cronograma-grade": {
    titulo: "Cronograma — Grade semanal",
    render: () => {
      // `GradeSemanal` dispara `carregarMaterias()` no próprio `useEffect`
      // de montagem, e essa ação só pula o round-trip de IPC quando
      // `materiasStatus` já está `"ready"` (`store.ts`). Por isso a store é
      // populada AQUI, síncrono, antes do componente montar — nunca dentro
      // de um `useEffect` deste cenário, porque o efeito do próprio
      // `GradeSemanal` rodaria primeiro (efeito de filho roda antes do de
      // pai) e ainda pegaria `materiasStatus: "idle"`, disparando a chamada
      // real que a vitrine existe para evitar.
      useCronogramaStore.setState({ materias: MATERIAS_FIXTURE, materiasStatus: "ready" });
      return (
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-8">
          <GradeSemanal semana={SEMANA_FIXTURE} />
        </div>
      );
    },
  },
  "cronograma-colunas": {
    titulo: "Cronograma — Visão de colunas",
    render: () => (
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-8">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
          {DIAS_FIXTURE.map((dia) => (
            <ColunaDoDia key={dia.data} dia={dia} />
          ))}
        </div>
      </div>
    ),
  },
  "biblioteca-estante": {
    titulo: "Biblioteca — Estante",
    render: () => (
      <div className="px-8 py-8">
        {/* Vitrine é só leitura: abrir/remover não precisam fazer nada real. */}
        <GradeDeLivros livros={LIVROS_FIXTURE} onAbrir={() => {}} onRemover={() => {}} />
      </div>
    ),
  },
  "mapa-mental-50": cenarioDeMapaMental(50),
  "mapa-mental-200": cenarioDeMapaMental(200),
  "mapa-mental-500": cenarioDeMapaMental(500),
  "trilha-pequena": cenarioDeTrilha("Trilha — pequena (8 etapas, 2 raias)", TRILHA_PEQUENA_FIXTURE),
  "trilha-media": cenarioDeTrilha("Trilha — média (20 etapas, 4 raias, ramificação e ciclo)", TRILHA_MEDIA_FIXTURE),
  "trilha-com-decisao": cenarioDeTrilha("Trilha — com decisão (14 etapas, caminhos alternativos)", TRILHA_COM_DECISAO_FIXTURE),
};
