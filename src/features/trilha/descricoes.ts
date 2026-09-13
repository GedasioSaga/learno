import type { Decisao, EtapaDaTrilha, FlechaDaTrilha } from "../../lib/ipc";

/**
 * O estado VISUAL de uma etapa — cinco possibilidades, sempre mutuamente
 * exclusivas (docs/DESIGN-TRILHA.md §3). `EtapaDaTrilha` não guarda isto
 * pronto: `state` (progresso) e `inCycle`/`isUnlocked` (grafo) chegam
 * separados, e é aqui que a prioridade entre eles fica decidida uma vez só.
 *
 * ORDEM DE PRIORIDADE, e por quê: concluída vence ciclo — uma etapa que o
 * usuário já terminou não está "travada" nem precisa do aviso de ciclo,
 * mesmo que ela também feche um laço de dependência; o aviso de ciclo só
 * importa enquanto a etapa ainda não desbloqueou sozinha. Ciclo vence
 * bloqueada/disponível porque `isUnlocked` de uma etapa em ciclo nunca vira
 * `true` por conta própria (TRAVA do domínio) — sem essa prioridade a etapa
 * apareceria só como "bloqueada" para sempre, sem explicar o motivo real.
 *
 * `situacaoNoCaminho` (ver o tipo homônimo, mais abaixo) é um eixo
 * ORTOGONAL a este: uma etapa "descartada" pode estar em qualquer um dos
 * cinco estados de progresso acima (inclusive concluída — descartar o
 * caminho nunca apaga trabalho feito). Por isso não entra neste tipo nem
 * nesta função; quem monta a tela combina os dois eixos separadamente.
 */
export type EstadoVisualDaEtapa = "disponivel" | "bloqueada" | "em-andamento" | "concluida" | "em-ciclo";

export function estadoVisualDaEtapa(etapa: EtapaDaTrilha): EstadoVisualDaEtapa {
  if (etapa.state === "done") return "concluida";
  if (etapa.inCycle) return "em-ciclo";
  if (etapa.state === "in_progress") return "em-andamento";
  return etapa.isUnlocked ? "disponivel" : "bloqueada";
}

/** As etapas que bloqueiam `etapa` e ainda não foram concluídas — o que falta, de verdade, para ela desbloquear. */
export function bloqueadorasNaoConcluidas(
  etapa: EtapaDaTrilha,
  todasEtapas: readonly EtapaDaTrilha[],
  flechas: readonly FlechaDaTrilha[],
): EtapaDaTrilha[] {
  const idsBloqueadores = new Set(flechas.filter((flecha) => flecha.blockedId === etapa.id).map((flecha) => flecha.blockingId));
  return todasEtapas.filter((candidata) => idsBloqueadores.has(candidata.id) && candidata.state !== "done");
}

/** As outras etapas em ciclo diretamente ligadas a `etapa` por uma flecha (nos dois sentidos). */
function vizinhasNoCiclo(etapa: EtapaDaTrilha, todasEtapas: readonly EtapaDaTrilha[], flechas: readonly FlechaDaTrilha[]): EtapaDaTrilha[] {
  const idsVizinhos = new Set(
    flechas
      .filter((flecha) => flecha.blockedId === etapa.id || flecha.blockingId === etapa.id)
      .map((flecha) => (flecha.blockedId === etapa.id ? flecha.blockingId : flecha.blockedId)),
  );
  return todasEtapas.filter((candidata) => candidata.inCycle && idsVizinhos.has(candidata.id));
}

/** Uma flecha de entrada com rótulo — a etapa de origem já resolvida para objeto, não só o id. */
interface CaminhoQueAlimenta {
  decisao: EtapaDaTrilha;
  pathLabel: string;
}

/** As flechas que chegam em `etapa` e carregam rótulo de caminho — as que vêm de uma decisão. */
function caminhosQueAlimentam(
  etapa: EtapaDaTrilha,
  todasEtapas: readonly EtapaDaTrilha[],
  flechas: readonly FlechaDaTrilha[],
): CaminhoQueAlimenta[] {
  const resultado: CaminhoQueAlimenta[] = [];
  for (const flecha of flechas) {
    if (flecha.blockedId !== etapa.id || flecha.pathLabel === null) continue;
    const decisao = todasEtapas.find((candidata) => candidata.id === flecha.blockingId);
    // Defensivo, como o resto do arquivo: sem a etapa de origem no array não
    // há título para mostrar, então o caminho simplesmente não entra na lista.
    if (decisao) resultado.push({ decisao, pathLabel: flecha.pathLabel });
  }
  return resultado;
}

/**
 * As decisões (como etapa) que ainda não escolheram — e por isso deixam
 * `etapa` em suspenso. É a resposta a "esperando o quê?" de `aguardandoEscolha`.
 */
export function decisoesPendentesPara(
  etapa: EtapaDaTrilha,
  todasEtapas: readonly EtapaDaTrilha[],
  flechas: readonly FlechaDaTrilha[],
  decisoes: readonly Decisao[],
): EtapaDaTrilha[] {
  const idsPendentes = new Set(
    caminhosQueAlimentam(etapa, todasEtapas, flechas)
      .filter((caminho) => decisoes.find((decisao) => decisao.stepId === caminho.decisao.id)?.chosenLabel === null)
      .map((caminho) => caminho.decisao.id),
  );
  return todasEtapas.filter((candidata) => idsPendentes.has(candidata.id));
}

/** Um caminho que alimentava `etapa` e perdeu: outro rótulo venceu na mesma decisão. */
export interface CaminhoDescartado {
  decisao: EtapaDaTrilha;
  pathLabel: string;
  escolhido: string;
}

/** Os caminhos mortos que hoje alimentariam `etapa` — o "por quê" de `descartado`. */
export function caminhosDescartadosPara(
  etapa: EtapaDaTrilha,
  todasEtapas: readonly EtapaDaTrilha[],
  flechas: readonly FlechaDaTrilha[],
  decisoes: readonly Decisao[],
): CaminhoDescartado[] {
  const descartados: CaminhoDescartado[] = [];
  for (const caminho of caminhosQueAlimentam(etapa, todasEtapas, flechas)) {
    const decisaoInfo = decisoes.find((decisao) => decisao.stepId === caminho.decisao.id);
    if (decisaoInfo && decisaoInfo.chosenLabel !== null && decisaoInfo.chosenLabel !== caminho.pathLabel) {
      descartados.push({ decisao: caminho.decisao, pathLabel: caminho.pathLabel, escolhido: decisaoInfo.chosenLabel });
    }
  }
  return descartados;
}

/** Os rótulos únicos dos caminhos que saem de uma decisão, na ordem em que as flechas aparecem — o que o nó oferece para escolher. */
export function rotulosDosCaminhosQueSaem(decisionId: string, flechas: readonly FlechaDaTrilha[]): string[] {
  const vistos = new Set<string>();
  const rotulos: string[] = [];
  for (const flecha of flechas) {
    if (flecha.blockingId !== decisionId || flecha.pathLabel === null || vistos.has(flecha.pathLabel)) continue;
    vistos.add(flecha.pathLabel);
    rotulos.push(flecha.pathLabel);
  }
  return rotulos;
}

/**
 * A descrição textual completa de uma etapa — a MESMA fonte para o
 * `aria-label` do nó no canvas e para a lista `sr-only` de `TrilhaCanvas`.
 * Existe porque um leitor de tela não lê `::before` (o glifo do estado é CSS
 * puro, ver trilha.css) nem confia em cor sozinha para transmitir estado.
 *
 * `decisoes` é opcional (lista vazia por padrão) só para não quebrar quem já
 * chamava esta função com três argumentos antes de `situacaoNoCaminho`
 * existir — sem a lista, a etapa ainda anuncia que está em suspenso/
 * descartada (o campo já vem pronto do backend), só não nomeia QUAL decisão.
 */
export function descricaoParaLeitorDeTela(
  etapa: EtapaDaTrilha,
  todasEtapas: readonly EtapaDaTrilha[],
  flechas: readonly FlechaDaTrilha[],
  decisoes: readonly Decisao[] = [],
): string {
  let texto: string;
  switch (estadoVisualDaEtapa(etapa)) {
    case "concluida":
      texto = `${etapa.title} — concluída.`;
      break;
    case "em-andamento":
      texto = `${etapa.title} — em andamento.`;
      break;
    case "em-ciclo": {
      const outras = vizinhasNoCiclo(etapa, todasEtapas, flechas).map((e) => e.title);
      const complemento = outras.length > 0 ? ` com ${outras.join(", ")}` : "";
      texto = `${etapa.title} — em ciclo de dependência${complemento}. Nunca desbloqueia sozinha; apague uma das flechas do ciclo para corrigir.`;
      break;
    }
    case "bloqueada": {
      const faltando = bloqueadorasNaoConcluidas(etapa, todasEtapas, flechas).map((e) => e.title);
      const complemento = faltando.length > 0 ? `, falta concluir ${faltando.join(", ")}` : "";
      texto = `${etapa.title} — bloqueada${complemento}.`;
      break;
    }
    case "disponivel":
      texto = `${etapa.title} — disponível, pode começar.`;
      break;
  }

  if (decisoes.some((decisao) => decisao.stepId === etapa.id)) {
    texto += " É uma decisão: escolha um caminho no próprio nó.";
  }

  if (etapa.situacaoNoCaminho === "aguardandoEscolha") {
    const pendentes = decisoesPendentesPara(etapa, todasEtapas, flechas, decisoes).map((e) => e.title);
    const complemento = pendentes.length > 0 ? ` de ${pendentes.join(", ")}` : "";
    texto += ` Em suspenso, aguardando a escolha${complemento}.`;
  } else if (etapa.situacaoNoCaminho === "descartado") {
    const descartados = caminhosDescartadosPara(etapa, todasEtapas, flechas, decisoes);
    const explicacao =
      descartados.length > 0 ? ` ${descartados[0].decisao.title} escolheu "${descartados[0].escolhido}" em vez de "${descartados[0].pathLabel}".` : "";
    const progresso = etapa.state !== null ? " O progresso desta etapa continua salvo; escolher este caminho de novo o traz de volta." : "";
    texto += ` O caminho até aqui foi descartado.${explicacao}${progresso}`;
  }

  return texto;
}
