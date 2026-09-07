/**
 * O modelo puro de "lacunas marcadas sobre um texto" — o que
 * `CriarLacunaDeOrigem` acumula antes de salvar, e o que vira a string
 * `{{cN::...}}` que o backend (`db::cloze`, no Rust) vai parsear.
 *
 * ## Por que isto NÃO é uma segunda gramática de cloze
 *
 * `db::cloze` (Rust) é o único lugar que INTERPRETA `{{cN::texto}}`, e o
 * comentário de módulo dele explica por que a tela nunca parseia essa
 * sintaxe. Este arquivo respeita isso pelo outro lado: aqui não existe
 * parser, só um GERADOR. A tela guarda a forma estruturada (intervalo +
 * número) e produz a string uma vez, na hora de salvar. A prévia de
 * "quantos cartões nascem" (`cartoesDe`, `segmentosDoCartao`) é calculada
 * sobre a forma estruturada, nunca lendo `{{` de volta — então não há duas
 * gramáticas para divergir.
 *
 * ## A semântica do Anki que este modelo reproduz
 *
 * `Ctrl+Shift+C` no Anki INCREMENTA o número (`c1`, depois `c2`: duas
 * perguntas separadas); segurar `Alt` REUSA o número mais alto (uma
 * pergunta com dois buracos). Aqui isso é `novaLacuna` vs `mesmaLacuna` —
 * a decisão é do gesto, e muda quantos cartões nascem, por isso o número de
 * cartões é derivado (`cartoesDe`) e não guardado: não pode desandar do que
 * as lacunas dizem.
 *
 * ## Invariantes que `adicionarLacuna` garante (e os testes cobram)
 *
 * - intervalo não vazio depois de aparar espaços nas pontas (uma lacuna de
 *   só espaço não pergunta nada);
 * - intervalo dentro do texto e sem sobrepor outra lacuna (`{{c1::{{c2::`
 *   aninhado é exatamente a entrada hostil que o parser total do Rust
 *   engole em silêncio como "nenhuma lacuna" — melhor recusar aqui, com
 *   motivo, do que salvar uma nota que não pergunta);
 * - o trecho não contém `{{` nem `}}`: são a marcação, e dentro de uma
 *   lacuna virariam aninhamento.
 */

import type { ClozeSegment } from "../../lib/ipc";

/** Intervalo `[inicio, fim)` de índices de string (UTF-16) sobre o texto do bloco. */
export interface Intervalo {
  inicio: number;
  fim: number;
}

export interface Lacuna extends Intervalo {
  /** O `N` de `{{cN::...}}`: lacunas com o mesmo número escondem-se juntas, no mesmo cartão. */
  numero: number;
}

/** Por que uma seleção não pôde virar lacuna — texto pronto para a tela. */
export type MotivoDeRecusa =
  | "vazia"
  | "fora-do-texto"
  | "sobrepoe"
  | "contem-marcacao";

export const MENSAGEM_DE_RECUSA: Record<MotivoDeRecusa, string> = {
  vazia: "Selecione ao menos uma letra para virar lacuna.",
  "fora-do-texto": "Selecione dentro do texto do cartão.",
  sobrepoe: "Esse trecho já está dentro de uma lacuna.",
  "contem-marcacao": "O trecho contém “{{” ou “}}”, que é a própria marcação de lacuna — escolha outro.",
};

export type ResultadoDeLacuna = { ok: true; lacunas: Lacuna[] } | { ok: false; motivo: MotivoDeRecusa };

const ABRE = "{{";
const FECHA = "}}";

/** Encolhe o intervalo até as pontas não serem espaço. Pode devolver vazio. */
export function apararIntervalo(texto: string, intervalo: Intervalo): Intervalo {
  let { inicio, fim } = intervalo;
  while (inicio < fim && /\s/.test(texto[inicio] ?? "")) inicio += 1;
  while (fim > inicio && /\s/.test(texto[fim - 1] ?? "")) fim -= 1;
  return { inicio, fim };
}

function sobrepoe(a: Intervalo, b: Intervalo): boolean {
  return a.inicio < b.fim && b.inicio < a.fim;
}

/**
 * O número que `novaLacuna` daria: um acima do maior existente (`c1` se não
 * há nenhuma). Não é "quantidade + 1" de propósito: se o usuário remover a
 * `c1` e ficar só com a `c2`, a próxima é `c3` — como no Anki, os números
 * não precisam ser contíguos, e renumerar por baixo dos pés confundiria a
 * prévia que ele já viu.
 */
export function proximoNumero(lacunas: readonly Lacuna[]): number {
  return lacunas.reduce((maior, lacuna) => Math.max(maior, lacuna.numero), 0) + 1;
}

/** O número que `mesmaLacuna` reusa — o mais alto, como o `Alt` do Anki. `null` sem nenhuma lacuna. */
export function numeroAtual(lacunas: readonly Lacuna[]): number | null {
  return lacunas.length === 0 ? null : proximoNumero(lacunas) - 1;
}

/**
 * Tenta acrescentar `intervalo` como lacuna de `numero`. Devolve a lista
 * nova ordenada por posição, ou o motivo da recusa — nunca lança.
 */
export function adicionarLacuna(
  texto: string,
  lacunas: readonly Lacuna[],
  intervalo: Intervalo,
  numero: number,
): ResultadoDeLacuna {
  if (intervalo.inicio < 0 || intervalo.fim > texto.length || intervalo.inicio > intervalo.fim) {
    return { ok: false, motivo: "fora-do-texto" };
  }
  const aparado = apararIntervalo(texto, intervalo);
  if (aparado.inicio === aparado.fim) return { ok: false, motivo: "vazia" };

  const trecho = texto.slice(aparado.inicio, aparado.fim);
  if (trecho.includes(ABRE) || trecho.includes(FECHA)) return { ok: false, motivo: "contem-marcacao" };
  if (lacunas.some((existente) => sobrepoe(existente, aparado))) return { ok: false, motivo: "sobrepoe" };

  const novas = [...lacunas, { ...aparado, numero }].sort((a, b) => a.inicio - b.inicio);
  return { ok: true, lacunas: novas };
}

/** Atalho: nova pergunta (`c(max+1)`), o `Ctrl+Shift+C` do Anki. */
export function novaLacuna(texto: string, lacunas: readonly Lacuna[], intervalo: Intervalo): ResultadoDeLacuna {
  return adicionarLacuna(texto, lacunas, intervalo, proximoNumero(lacunas));
}

/**
 * Atalho: mais um buraco na pergunta atual (`c(max)`), o `Alt` do Anki. Sem
 * nenhuma lacuna ainda não há "mesma" para reusar — vira `c1`, igual a
 * `novaLacuna`, em vez de falhar: o usuário pediu uma lacuna e ganha uma.
 */
export function mesmaLacuna(texto: string, lacunas: readonly Lacuna[], intervalo: Intervalo): ResultadoDeLacuna {
  return adicionarLacuna(texto, lacunas, intervalo, numeroAtual(lacunas) ?? 1);
}

export function removerLacuna(lacunas: readonly Lacuna[], alvo: Lacuna): Lacuna[] {
  return lacunas.filter((lacuna) => lacuna !== alvo);
}

/** Os números distintos, em ordem — um cartão por item. É ISTO que a tela mostra antes de salvar. */
export function cartoesDe(lacunas: readonly Lacuna[]): number[] {
  return [...new Set(lacunas.map((lacuna) => lacuna.numero))].sort((a, b) => a - b);
}

/**
 * A string que vai para o campo `Texto` da nota: o texto do bloco com cada
 * lacuna embrulhada em `{{cN::...}}`. Tudo fora das lacunas fica byte a
 * byte igual — o cartão é uma CÓPIA do bloco; o bloco na página não muda.
 */
export function montarTextoCloze(texto: string, lacunas: readonly Lacuna[]): string {
  const ordenadas = [...lacunas].sort((a, b) => a.inicio - b.inicio);
  let saida = "";
  let cursor = 0;
  for (const lacuna of ordenadas) {
    saida += texto.slice(cursor, lacuna.inicio);
    saida += `${ABRE}c${lacuna.numero}::${texto.slice(lacuna.inicio, lacuna.fim)}${FECHA}`;
    cursor = lacuna.fim;
  }
  return saida + texto.slice(cursor);
}

/**
 * O que o cartão de `numero` mostra na frente — a mesma forma que o Rust
 * devolve em `CardToStudy.cloze`, para a prévia ser desenhada com a MESMA
 * peça visual da tela de estudo. Segmentos visíveis adjacentes já vêm
 * fundidos, como lá.
 */
export function segmentosDoCartao(texto: string, lacunas: readonly Lacuna[], numero: number): ClozeSegment[] {
  const ordenadas = [...lacunas].sort((a, b) => a.inicio - b.inicio);
  const segmentos: ClozeSegment[] = [];
  let cursor = 0;

  function visivel(trecho: string) {
    if (trecho === "") return;
    const ultimo = segmentos[segmentos.length - 1];
    if (ultimo && !ultimo.hidden) ultimo.text += trecho;
    else segmentos.push({ text: trecho, hidden: false, hint: null });
  }

  for (const lacuna of ordenadas) {
    visivel(texto.slice(cursor, lacuna.inicio));
    const trecho = texto.slice(lacuna.inicio, lacuna.fim);
    if (lacuna.numero === numero) segmentos.push({ text: trecho, hidden: true, hint: null });
    else visivel(trecho);
    cursor = lacuna.fim;
  }
  visivel(texto.slice(cursor));
  return segmentos;
}
