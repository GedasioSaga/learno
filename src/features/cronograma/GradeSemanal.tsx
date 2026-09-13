import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Materia, SemanaDeEstudo } from "../../lib/ipc";
import "./cronograma-grade.css";
import { abreviacaoDoDia, hojeLocal, rotuloCurtoDoDia } from "./date-utils";
import { corDoBloco } from "./cores";
import { formatarDuracao, rotuloDoBloco } from "./format";
import {
  construirGrade,
  GRANULARIDADE_MINUTOS,
  minutosDoHorario,
  minutosParaRotulo,
  type BlocoNaCelula,
  type ColunaDaGrade,
  type GrupoDeConflito,
} from "./grade";
import { BlocoCard } from "./BlocoCard";
import { useCronogramaStore } from "./store";

interface GradeSemanalProps {
  semana: SemanaDeEstudo;
}

/**
 * `CSSProperties` fechou a assinatura de índice para `--*` (ver o mesmo
 * contorno em `features/pages/PageSurface.tsx`); aqui a posição de cada
 * bloco na coluna É uma variável CSS (`--inicio`, `--duracao`, `--lane`),
 * em MINUTOS, que `cronograma-grade.css` converte em `top`/`height` — o
 * componente não calcula pixel nenhum.
 */
interface EstiloComVariaveisCss extends CSSProperties {
  [propriedade: `--${string}`]: string | number | undefined;
}

const MINUTOS_POR_DIA = 24 * 60;
/** Um rótulo de hora cheia a menos de 12 min da linha do agora colidiria com o horário atual na calha — some, o horário atual o substitui. */
const RAIO_DE_COLISAO_DO_ROTULO_MINUTOS = 12;
const UM_MINUTO_MS = 60_000;
/** Abaixo disto (≈37px) só cabe UMA linha de texto; abaixo de 50 min (≈47px), duas — um Pomodoro de 50 min já mostra as três. Ver `nivelDeConteudo`. */
const MINUTOS_PARA_DUAS_LINHAS = 40;
const MINUTOS_PARA_TRES_LINHAS = 50;
/**
 * Largura mínima de uma lane, em px. Abaixo disto o título vira fragmento
 * ("Pomo…") e o bloco deixa de ser reconhecível de relance. 64px cabem
 * "Pomodoro", "História", "Redação" inteiros nos 11px da lane dividida
 * (ver `[data-dividido]` em `cronograma-grade.css`) e ainda mostram
 * "Matemát…" — que já diz qual é. Numa coluna de ~148px (largura da grade
 * em `max-w-6xl`) cabem duas lanes; a terceira vai pro "+N".
 */
const LARGURA_MINIMA_DA_LANE_PX = 64;
/** O que `.grade__bloco` desconta da largura da coluna antes de dividir (2px de cada lado + 1px da borda esquerda da coluna). */
const MARGEM_HORIZONTAL_DA_COLUNA_PX = 5;
/** Colunas do lado direito da grade abrem o painel "+N" pra esquerda, pra não estourar a borda da tela. */
const PRIMEIRA_COLUNA_QUE_ABRE_PARA_A_ESQUERDA = 4;

type EstadoDoBloco = "passado" | "agora" | "futuro";

/**
 * A visão de Grade: dias em colunas, horas em linhas, um bloco por matéria
 * na posição do horário dele — o desenho de qualquer calendário semanal.
 *
 * O que é decisão de LAYOUT (e vive em `grade.ts`, pura e testada): faixa
 * de horário derivada dos blocos, granularidade de 30 min, lanes lado a
 * lado em conflito. O que é decisão de TELA (aqui e em
 * `cronograma-grade.css`):
 *
 * - A grade é o próprio contêiner de rolagem, com cabeçalho de dias, faixa
 *   "sem horário" e calha de horas presos (`position: sticky`), e abre já
 *   rolada até a linha do agora quando hoje está na semana — a manhã vazia
 *   não ocupa a tela, mas continua ali, uma rolada acima.
 * - Bloco é `role="group"` com `aria-label` completo (dia, horário, rótulo,
 *   matéria) — é isso que dá a um leitor de tela o par dia+hora, não uma
 *   `<table>`: o eixo de horas e as linhas são decoração (`aria-hidden`).
 * - O estado passado/agora/futuro vem SÓ do relógio (`estadoDoBloco`).
 *   "Concluído" exigiria um dado por bloco que não existe
 *   (`minutosRealizados` é por dia) — não é inventado.
 * - Conflito de horário divide a largura do GRUPO (`grade.ts`) em lanes
 *   iguais até `LARGURA_MINIMA_DA_LANE_PX`; o que não cabe não vira fatia
 *   ilegível — fica atrás de um botão "+N" (`MaisBlocos`) que abre um painel
 *   com os blocos escondidos. Quantas lanes cabem é medido na largura real
 *   da coluna (`useLanesQueCabem`), nunca chutado.
 */
export function GradeSemanal({ semana }: GradeSemanalProps) {
  const materias = useCronogramaStore((state) => state.materias);
  const carregarMaterias = useCronogramaStore((state) => state.carregarMaterias);

  // A grade é a única visão que colore por matéria (`cores.ts`) — carrega
  // sob demanda aqui, não em `ConteudoDeCronograma`, porque a visão de
  // Colunas nunca precisa da lista. `carregarMaterias` já se protege contra
  // chamada concorrente/redundante (`materiasStatus`, ver `store.ts`).
  useEffect(() => {
    void carregarMaterias();
  }, [carregarMaterias]);

  const agora = useAgora();
  const grade = construirGrade(semana);
  const algumDiaTemBlocoSemHorario = grade.colunas.some((coluna) => coluna.semHorario.length > 0);
  const hoje = hojeLocal(agora.data);
  const hojeNaSemana = grade.colunas.some((coluna) => coluna.data === hoje);

  const inicioDaGrade = grade.faixas[0]?.minutoInicio ?? 0;
  const fimDaGrade = grade.faixas.length > 0 ? grade.faixas[grade.faixas.length - 1].minutoInicio + GRANULARIDADE_MINUTOS : 0;
  const agoraNaGrade = hojeNaSemana && agora.minutos >= inicioDaGrade && agora.minutos <= fimDaGrade;
  const offsetDoAgora = agora.minutos - inicioDaGrade;

  const rolagemRef = useRef<HTMLDivElement>(null);
  const linhaDoAgoraRef = useRef<HTMLDivElement>(null);
  const lanesQueCabem = useLanesQueCabem(rolagemRef);

  // Se a linha do agora nasce fora da área visível, abre rolada até ela (a
  // 30% do topo) — UMA vez, na montagem; depois a rolagem é do usuário e a
  // linha continua andando sozinha (`useAgora`) sem puxar a tela. Se ela já
  // está visível, não rola: a manhã fica inteira, sem bloco cortado sob o
  // cabeçalho.
  useEffect(() => {
    const contentor = rolagemRef.current;
    const linha = linhaDoAgoraRef.current;
    if (!contentor || !linha) return;
    const topoDaLinha = linha.getBoundingClientRect().top - contentor.getBoundingClientRect().top + contentor.scrollTop;
    if (topoDaLinha < contentor.clientHeight) return;
    contentor.scrollTop = Math.max(0, topoDaLinha - contentor.clientHeight * 0.3);
  }, []);

  const estiloDaGrade: EstiloComVariaveisCss = {
    "--grade-faixas": grade.faixas.length,
    "--grade-agora-offset": agoraNaGrade ? offsetDoAgora : undefined,
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        ref={rolagemRef}
        data-slot="grade-semanal"
        role="group"
        aria-label={`Grade da semana de ${rotuloCurtoDoDia(semana.inicio)}`}
        style={estiloDaGrade}
      >
        <div className="grade__cabecalho">
          <div className="grade__canto" aria-hidden="true" />
          {grade.colunas.map((coluna, indice) => (
            <CabecalhoDoDia key={coluna.data} data={coluna.data} ehHoje={coluna.data === hoje} primeiro={indice === 0} />
          ))}
        </div>

        {algumDiaTemBlocoSemHorario ? (
          <section className="grade__sem-horario" aria-labelledby="grade-sem-horario-titulo">
            <div className="grade__canto">
              <h2 id="grade-sem-horario-titulo" className="sr-only">
                Sem horário definido
              </h2>
              <p className="grade__sem-horario-rotulo" aria-hidden="true">
                sem
                <br />
                horário
              </p>
            </div>
            {grade.colunas.map((coluna) => (
              <div key={coluna.data} className="grade__sem-horario-dia">
                {coluna.semHorario.map((bloco) => (
                  <BlocoCard key={bloco.id} bloco={bloco} cor={corDoBloco(bloco, materias)} />
                ))}
              </div>
            ))}
          </section>
        ) : null}

        {grade.temBlocoComHorario ? (
          <div className="grade__corpo">
            <div className="grade__calha grade__canto" aria-hidden="true">
              {grade.faixas.map((faixa, indice) =>
                faixa.minutoInicio % 60 === 0 ? (
                  <RotuloDeHora
                    key={faixa.minutoInicio}
                    linha={indice}
                    minuto={faixa.minutoInicio}
                    escondido={agoraNaGrade && Math.abs(faixa.minutoInicio - agora.minutos) < RAIO_DE_COLISAO_DO_ROTULO_MINUTOS}
                  />
                ) : null,
              )}
              <RotuloDeHora
                linha={grade.faixas.length}
                minuto={fimDaGrade}
                escondido={agoraNaGrade && Math.abs(fimDaGrade - agora.minutos) < RAIO_DE_COLISAO_DO_ROTULO_MINUTOS}
              />
              {agoraNaGrade ? <span className="grade__agora-rotulo">{minutosParaRotulo(agora.minutos)}</span> : null}
            </div>

            {grade.colunas.map((coluna, indice) => (
              <ColunaDaSemana
                key={coluna.data}
                coluna={coluna}
                inicioDaGrade={inicioDaGrade}
                materias={materias}
                hoje={hoje}
                agoraMinutos={agora.minutos}
                mostrarLinhaDoAgora={agoraNaGrade && coluna.data === hoje}
                linhaDoAgoraRef={linhaDoAgoraRef}
                lanesQueCabem={lanesQueCabem}
                painelAbreParaEsquerda={indice >= PRIMEIRA_COLUNA_QUE_ABRE_PARA_A_ESQUERDA}
              />
            ))}

            {agoraNaGrade ? <div className="grade__agora" aria-hidden="true" /> : null}
          </div>
        ) : (
          <p className="m-4 rounded-md border border-dashed border-border p-4 text-sm text-ink-muted">
            Nenhum bloco com horário definido nesta semana ainda. Defina um horário num bloco (ou crie um novo com
            horário) para ele aparecer na grade.
          </p>
        )}
      </div>
    </div>
  );
}

/** Relógio de parede local, atualizado a cada minuto — só o suficiente pra linha do agora andar. */
function useAgora(): { data: Date; minutos: number } {
  const [data, setData] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setData(new Date()), UM_MINUTO_MS);
    return () => window.clearInterval(id);
  }, []);
  return { data, minutos: data.getHours() * 60 + data.getMinutes() };
}

/**
 * Quantas lanes de `LARGURA_MINIMA_DA_LANE_PX` cabem numa coluna de dia,
 * medindo a primeira `.grade__coluna` de verdade (todas têm a mesma largura,
 * `repeat(7, minmax(0, 1fr))`) e remedindo quando o contêiner muda de
 * tamanho. Sem medida (jsdom, sem `ResizeObserver`) devolve `Infinity`: na
 * dúvida, mostra tudo — esconder bloco atrás de "+N" por uma largura que
 * não foi medida seria esconder sem motivo.
 *
 * `useLayoutEffect`, não `useEffect`: a primeira medida acontece ANTES do
 * primeiro paint. Com `useEffect`, o primeiro quadro saía com `Infinity`
 * — todas as lanes do grupo lado a lado, cada uma com a largura que
 * sobrasse, abaixo dos 64px mínimos — e só o quadro seguinte corrigia.
 * Numa máquina lenta esse quadro fica na tela tempo suficiente pra ser
 * visto como "os blocos se atropelam". Nenhum quadro pode desenhar uma
 * lane menor que a mínima.
 */
function useLanesQueCabem(rolagemRef: RefObject<HTMLDivElement | null>): number {
  const [lanes, setLanes] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const contentor = rolagemRef.current;
    if (!contentor || typeof ResizeObserver === "undefined") return;
    function medir() {
      const coluna = contentor?.querySelector<HTMLElement>(".grade__coluna");
      const largura = coluna?.getBoundingClientRect().width ?? 0;
      if (largura <= 0) return;
      setLanes(Math.max(1, Math.floor((largura - MARGEM_HORIZONTAL_DA_COLUNA_PX) / LARGURA_MINIMA_DA_LANE_PX)));
    }
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(contentor);
    return () => observador.disconnect();
  }, [rolagemRef]);
  return lanes;
}

function CabecalhoDoDia({ data, ehHoje, primeiro }: { data: string; ehHoje: boolean; primeiro: boolean }) {
  const numero = Number(data.slice(8, 10));
  // "7 de set." -> "set.": o mês só aparece na primeira coluna e no dia 1,
  // quando a semana vira o mês — o resto do tempo o número basta, como em
  // qualquer calendário. Derivado do mesmo formatador pt-BR de
  // `rotuloCurtoDoDia` pra não abrir outro em `date-utils`.
  const mes = rotuloCurtoDoDia(data).split(" de ")[1];
  const mostrarMes = primeiro || numero === 1;
  return (
    <div
      className="grade__dia"
      data-hoje={ehHoje ? "true" : undefined}
      aria-current={ehHoje ? "date" : undefined}
      aria-label={`${abreviacaoDoDia(data)} ${rotuloCurtoDoDia(data)}${ehHoje ? ", hoje" : ""}`}
    >
      <span className="grade__dia-nome" aria-hidden="true">
        {abreviacaoDoDia(data)}
      </span>
      <span className="grade__dia-numero" aria-hidden="true">
        {numero}
      </span>
      {mostrarMes ? (
        <span className="grade__dia-mes" aria-hidden="true">
          {mes}
        </span>
      ) : null}
    </div>
  );
}

function RotuloDeHora({ linha, minuto, escondido }: { linha: number; minuto: number; escondido: boolean }) {
  // "24:00" não é um horário que existe — a linha de fim do dia é "00:00".
  const texto = minuto === MINUTOS_POR_DIA ? "00:00" : minutosParaRotulo(minuto);
  const estilo: EstiloComVariaveisCss = { "--linha": linha };
  return (
    <span className="grade__hora" style={estilo} hidden={escondido}>
      {texto}
    </span>
  );
}

function ColunaDaSemana({
  coluna,
  inicioDaGrade,
  materias,
  hoje,
  agoraMinutos,
  mostrarLinhaDoAgora,
  linhaDoAgoraRef,
  lanesQueCabem,
  painelAbreParaEsquerda,
}: {
  coluna: ColunaDaGrade;
  inicioDaGrade: number;
  materias: readonly Materia[];
  hoje: string;
  agoraMinutos: number;
  mostrarLinhaDoAgora: boolean;
  linhaDoAgoraRef: RefObject<HTMLDivElement | null>;
  lanesQueCabem: number;
  painelAbreParaEsquerda: boolean;
}) {
  return (
    <div
      className="grade__coluna"
      data-dia={coluna.data}
      data-lanes={coluna.totalLanes}
      data-hoje={coluna.data === hoje ? "true" : undefined}
      role="group"
      aria-label={`${abreviacaoDoDia(coluna.data)} ${rotuloCurtoDoDia(coluna.data)}`}
    >
      {coluna.grupos.map((grupo, indice) => {
        // Divide a largura do grupo em lanes iguais SÓ até a mínima legível;
        // o resto vai pro "+N". `lanesQueCabem` é `Infinity` sem medida.
        const lanesVisiveis = Math.min(grupo.totalLanes, lanesQueCabem);
        const visiveis = grupo.blocos.filter((posicao) => posicao.lane < lanesVisiveis);
        const escondidos = grupo.blocos.filter((posicao) => posicao.lane >= lanesVisiveis);
        return (
          <Fragment key={indice}>
            {visiveis.map((posicao) => (
              <BlocoNaGrade
                key={posicao.bloco.id}
                posicao={posicao}
                lanesVisiveis={lanesVisiveis}
                reservarCantoParaMais={escondidos.length > 0 && posicao.lane === lanesVisiveis - 1}
                inicioDaGrade={inicioDaGrade}
                dia={coluna.data}
                materias={materias}
                estado={estadoDoBloco(posicao, coluna.data, hoje, agoraMinutos)}
              />
            ))}
            {escondidos.length > 0 ? (
              <MaisBlocos
                grupo={grupo}
                escondidos={escondidos}
                inicioDaGrade={inicioDaGrade}
                dia={coluna.data}
                materias={materias}
                hoje={hoje}
                agoraMinutos={agoraMinutos}
                abreParaEsquerda={painelAbreParaEsquerda}
              />
            ) : null}
          </Fragment>
        );
      })}
      {mostrarLinhaDoAgora ? (
        <div ref={linhaDoAgoraRef} className="grade__agora-hoje">
          <span className="sr-only">agora: {minutosParaRotulo(agoraMinutos)}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Passado / agora / futuro pelo relógio, e só por ele: dia anterior a hoje
 * é passado inteiro; dia posterior, futuro inteiro; hoje compara o
 * intervalo do bloco com o minuto atual. Um bloco que atravessa a
 * meia-noite termina em 24:00 PARA ESTA COLUNA (`grade.ts` já clipa), então
 * ele fica "agora" até o fim do dia — que é o que o usuário vê acontecendo.
 */
function estadoDoBloco(posicao: BlocoNaCelula, dia: string, hoje: string, agoraMinutos: number): EstadoDoBloco {
  if (dia < hoje) return "passado";
  if (dia > hoje) return "futuro";
  const inicio = minutosDoHorario(posicao.horaInicio);
  const fim = posicao.bloco.crossesMidnight ? MINUTOS_POR_DIA : minutosDoHorario(posicao.horaFim);
  if (agoraMinutos >= fim) return "passado";
  if (agoraMinutos >= inicio) return "agora";
  return "futuro";
}

/**
 * Quantas linhas de texto cabem na ALTURA do bloco — decidido pela duração
 * em minutos (a altura é proporcional, ver `.grade__bloco`), não medindo
 * DOM. Um bloco que atravessa a meia-noite ganha 30 min de altura a mais
 * (a faixa de respiro do fim da coluna) só pra linha "continua amanhã".
 *
 * A altura decide QUANTAS linhas; a LARGURA decide o que cabe em cada uma,
 * e isso é medido pelo próprio flex em `cronograma-grade.css`
 * (`.grade__bloco-compacto`), nunca estimado aqui. Por isso o nível 1 rende
 * as três informações (título, matéria, horário) e o CSS descarta na ordem
 * fixa: fim do horário → início do horário → cauda da matéria → cauda do
 * título. Antes o nível 1 nem rendia a matéria, e o horário sumia numa
 * fileira escondida sem aviso — um bloco de 25 min com a coluna inteira
 * livre mostrava só "Pomodoro".
 */
function nivelDeConteudo(duracaoMinutos: number): 1 | 2 | 3 {
  if (duracaoMinutos < MINUTOS_PARA_DUAS_LINHAS) return 1;
  if (duracaoMinutos < MINUTOS_PARA_TRES_LINHAS) return 2;
  return 3;
}

function BlocoNaGrade({
  posicao,
  lanesVisiveis,
  reservarCantoParaMais,
  inicioDaGrade,
  dia,
  materias,
  estado,
}: {
  posicao: BlocoNaCelula;
  /** Em quantas partes a largura do grupo foi dividida — pode ser menor que `posicao.totalLanes` quando há "+N". */
  lanesVisiveis: number;
  /** Última lane visível de um grupo com "+N": a primeira linha deixa o canto direito livre pro botão. */
  reservarCantoParaMais: boolean;
  inicioDaGrade: number;
  dia: string;
  materias: readonly Materia[];
  estado: EstadoDoBloco;
}) {
  const rotulo = rotuloDoBloco(posicao.bloco);
  const cor = corDoBloco(posicao.bloco, materias);
  const materia = posicao.bloco.subjectId === null ? undefined : materias.find((m) => m.id === posicao.bloco.subjectId);
  const duracao = formatarDuracao(posicao.bloco);
  // O backend decide que um bloco que atravessa a meia-noite pertence
  // inteiro ao dia em que começou (`crossesMidnight`, Fase 1 do Cronograma)
  // — não é decisão desta tela mudar. Nesta coluna ele termina em 24:00
  // (`grade.ts` clipa); aqui ganha uma faixa a mais pra cruzar visivelmente
  // a linha das 00:00, e o texto "continua amanhã" confirma por escrito —
  // `horaFim` já mostra o horário real (ex. "00:15"), o sinal é redundante
  // de propósito.
  const continuaAmanha = posicao.bloco.crossesMidnight;
  const inicioMinutos = minutosDoHorario(posicao.horaInicio);
  const fimMinutos = continuaAmanha ? MINUTOS_POR_DIA : minutosDoHorario(posicao.horaFim);
  const duracaoNaColuna = Math.max(fimMinutos - inicioMinutos, 1);
  const nivel = nivelDeConteudo(duracaoNaColuna);
  const horario = `${posicao.horaInicio}–${posicao.horaFim}`;

  const rotuloDeAcessibilidade = [
    `${abreviacaoDoDia(dia)} ${rotuloCurtoDoDia(dia)}, ${posicao.horaInicio} às ${posicao.horaFim}: ${rotulo}`,
    materia ? materia.name : null,
    duracao,
    estado === "agora" ? "em andamento" : null,
    continuaAmanha ? "continua no dia seguinte" : null,
  ]
    .filter((parte) => parte !== null)
    .join(", ");

  const dividido = lanesVisiveis > 1;
  const estilo: EstiloComVariaveisCss = {
    "--inicio": inicioMinutos - inicioDaGrade,
    "--duracao": duracaoNaColuna + (continuaAmanha ? GRANULARIDADE_MINUTOS : 0),
    "--lane": posicao.lane,
    "--lanes": lanesVisiveis,
  };

  // O que não coube na altura (matéria, duração) ou na largura (lane
  // dividida esconde o horário inline) fica no tooltip nativo — além do
  // `aria-label`, que já tem tudo.
  const tooltip = nivel < 3 || dividido ? `${rotulo}${materia ? ` — ${materia.name}` : ""}, ${horario}, ${duracao}` : undefined;

  return (
    <div
      data-slot="bloco-na-grade"
      data-cor={cor}
      data-estado={estado}
      data-continua={continuaAmanha ? "true" : undefined}
      data-dividido={dividido ? "true" : undefined}
      data-reserva-mais={reservarCantoParaMais ? "true" : undefined}
      data-nivel={nivel}
      role="group"
      aria-label={rotuloDeAcessibilidade}
      title={tooltip}
      className="grade__bloco"
      style={estilo}
    >
      {nivel === 1 ? (
        // Uma linha só: "Título · Matéria" à esquerda, horário à direita.
        // Início e fim são spans SEPARADOS de propósito — é o que deixa o
        // CSS mostrar "08:50–09:15" inteiro, ou só "08:50", ou nada,
        // conforme a largura real (ver `.grade__bloco-compacto`).
        <div className="grade__bloco-linha grade__bloco-compacto">
          <p className="grade__bloco-nome">
            <span className="grade__bloco-titulo">{rotulo}</span>
            {materia ? <span className="grade__bloco-materia">{materia.name}</span> : null}
          </p>
          {estado === "agora" ? <span className="grade__bloco-agora">agora</span> : null}
          <span className="grade__bloco-horario">
            <span>{posicao.horaInicio}</span>
            <span className="grade__bloco-horario-fim">–{posicao.horaFim}</span>
          </span>
          <MarcaDeOmissao />
        </div>
      ) : null}
      {nivel === 2 ? (
        <>
          <div className="grade__bloco-linha">
            <p className="grade__bloco-titulo">{rotulo}</p>
            {estado === "agora" ? <span className="grade__bloco-agora">agora</span> : null}
          </div>
          <div className="grade__bloco-linha">
            {materia ? <p className="grade__bloco-materia">{materia.name}</p> : null}
            <span className="grade__bloco-horario">{horario}</span>
            <MarcaDeOmissao />
          </div>
        </>
      ) : null}
      {nivel === 3 ? (
        <>
          <div className="grade__bloco-linha">
            <p className="grade__bloco-titulo">{rotulo}</p>
            {estado === "agora" ? <span className="grade__bloco-agora">agora</span> : null}
          </div>
          {materia ? <p className="grade__bloco-materia">{materia.name}</p> : null}
          {/* Início e fim separados como no nível 1: na lane dividida o fim cai
              antes ("09:00", nunca "09:00–09…"), e a marca de omissão fecha a linha. */}
          <p className="grade__bloco-linha grade__bloco-horario">
            <span className="grade__bloco-intervalo">
              <span>{posicao.horaInicio}</span>
              <span className="grade__bloco-horario-fim">–{posicao.horaFim}</span>
            </span>
            <span className="grade__bloco-duracao">{duracao}</span>
            <MarcaDeOmissao />
          </p>
        </>
      ) : null}
      {continuaAmanha ? (
        <p className="grade__bloco-continua">
          {/* `aria-hidden`: o ícone é só reforço visual, o texto ao lado já carrega o sentido — nunca a única pista. */}
          <span aria-hidden="true">↷ </span>continua amanhã
        </p>
      ) : null}
    </div>
  );
}

/**
 * A marca de "descartei algo aqui": borda direita pontilhada na cor da
 * matéria, na ponta da linha que carrega o horário — o mesmo idioma de
 * "continua amanhã" (borda tracejada embaixo = isto continua), virado pro
 * lado. Custa zero pixel de largura, e é por isso que é uma borda e não um
 * "⋯": numa lane de 64px sobram 56px úteis e "Pomodoro" ocupa 55 — qualquer
 * glifo no fim da linha viraria "Pomod…" e derrubaria o argumento inteiro
 * de `LARGURA_MINIMA_DA_LANE_PX`.
 *
 * Está SEMPRE no DOM, e quem decide se aparece é a largura, como no resto
 * da folha: o horário (nível 1 e 2) ou a duração (nível 3) fica por cima
 * dela com fundo opaco (`cronograma-grade.css`, "Cobertura"). Quando o CSS
 * descarta o horário — `display: none` na lane dividida, ou a fileira
 * escondida do `flex-wrap` na coluna inteira — nada cobre, e a marca
 * aparece. Sem JS medindo, sem estado: um descarte que o componente não
 * enxerga não pode ficar sem marca. `aria-hidden`: o `aria-label` do bloco
 * já tem o horário completo, e o tooltip também.
 */
function MarcaDeOmissao() {
  return <span className="grade__bloco-omitido" aria-hidden="true" />;
}

/**
 * O "+N" de um grupo de conflito: botão no canto superior direito do grupo,
 * e o painel que lista os blocos que não couberam em lane legível — nenhum
 * bloco some da tela sem um caminho de volta. Abre por clique (raro, não é
 * ação de alta frequência: entra em escala 0.95 → 1, ease-out,
 * `--motion-base`); fecha por Escape, clique fora ou o próprio botão, e o
 * foco volta pro botão. Fechar é desmontar, instantâneo.
 */
function MaisBlocos({
  grupo,
  escondidos,
  inicioDaGrade,
  dia,
  materias,
  hoje,
  agoraMinutos,
  abreParaEsquerda,
}: {
  grupo: GrupoDeConflito;
  escondidos: readonly BlocoNaCelula[];
  inicioDaGrade: number;
  dia: string;
  materias: readonly Materia[];
  hoje: string;
  agoraMinutos: number;
  abreParaEsquerda: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const botaoRef = useRef<HTMLButtonElement>(null);
  const painelRef = useRef<HTMLDivElement>(null);
  const painelId = useId();

  useEffect(() => {
    if (!aberto) return;
    painelRef.current?.focus();
    function fecharSeClicouFora(evento: MouseEvent) {
      const alvo = evento.target;
      if (!(alvo instanceof Node)) return;
      if (painelRef.current?.contains(alvo) || botaoRef.current?.contains(alvo)) return;
      setAberto(false);
    }
    document.addEventListener("mousedown", fecharSeClicouFora);
    return () => document.removeEventListener("mousedown", fecharSeClicouFora);
  }, [aberto]);

  function fechar() {
    setAberto(false);
    botaoRef.current?.focus();
  }

  const janela = `${minutosParaRotulo(grupo.inicio)} às ${minutosParaRotulo(Math.min(grupo.fim, MINUTOS_POR_DIA - 1))}`;
  const quantos = escondidos.length === 1 ? "mais 1 bloco" : `mais ${escondidos.length} blocos`;
  const estilo: EstiloComVariaveisCss = { "--inicio": grupo.inicio - inicioDaGrade };

  return (
    <>
      <button
        ref={botaoRef}
        type="button"
        className="grade__mais"
        style={estilo}
        aria-haspopup="dialog"
        aria-expanded={aberto}
        aria-controls={aberto ? painelId : undefined}
        aria-label={`${quantos} no mesmo horário, ${janela}`}
        onClick={() => setAberto((estava) => !estava)}
      >
        +{escondidos.length}
      </button>
      {aberto ? (
        <div
          id={painelId}
          ref={painelRef}
          role="dialog"
          aria-label={`${abreviacaoDoDia(dia)} ${rotuloCurtoDoDia(dia)}, ${quantos} entre ${janela}`}
          tabIndex={-1}
          className="grade__mais-painel"
          data-lado={abreParaEsquerda ? "esquerda" : "direita"}
          style={estilo}
          onKeyDown={(evento) => {
            if (evento.key !== "Escape") return;
            evento.stopPropagation();
            fechar();
          }}
        >
          <p className="grade__mais-titulo">Também neste horário</p>
          <ul className="grade__mais-lista">
            {escondidos.map((posicao) => {
              const materia = posicao.bloco.subjectId === null ? undefined : materias.find((m) => m.id === posicao.bloco.subjectId);
              const estado = estadoDoBloco(posicao, dia, hoje, agoraMinutos);
              return (
                <li
                  key={posicao.bloco.id}
                  data-slot="bloco-escondido"
                  data-cor={corDoBloco(posicao.bloco, materias)}
                  data-estado={estado}
                  className="grade__mais-item"
                >
                  <div className="grade__bloco-linha">
                    <p className="grade__bloco-titulo">{rotuloDoBloco(posicao.bloco)}</p>
                    {estado === "agora" ? <span className="grade__bloco-agora">agora</span> : null}
                  </div>
                  {materia ? <p className="grade__bloco-materia">{materia.name}</p> : null}
                  <p className="grade__bloco-linha grade__bloco-horario">
                    <span>
                      {posicao.horaInicio}–{posicao.horaFim}
                    </span>
                    <span className="grade__bloco-duracao">{formatarDuracao(posicao.bloco)}</span>
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}
