/**
 * Capas fictícias da vitrine.
 *
 * Por que este arquivo existe: a fixture antiga dava a MESMA capa marrom
 * escrita "LIVRO" a todo livro com capa. Numa avaliação visual da estante
 * isso mente duas vezes — faz a grade parecer repetitiva por culpa do app
 * (quando a monotonia é da fixture), e esconde o contraste real entre uma
 * capa de verdade e a capa sintética que `LivroCard` gera sozinho quando
 * `coverFileName` é nulo. Quem olha a tela não tem como saber qual das duas
 * está vendo, e conclui a coisa errada sobre o produto.
 *
 * Cada livro recebe aqui uma capa visualmente distinta, derivada do próprio
 * id, para a estante parecer uma estante. As cores são CONTEÚDO de uma capa
 * fictícia, não chrome do app — por isso são hex cru e não tokens de tema:
 * a capa de um livro real também não segue o tema da interface.
 *
 * O mecanismo: `resolveMediaSrc` (`features/editor/blocks/media/media-storage.ts`)
 * devolve qualquer `data:`/`https:` direto, sem tocar em `@tauri-apps/plugin-fs`
 * nem em IPC (`isExternalMediaUrl`). É o que permite mostrar capa sem backend.
 */

/** Paletas de capa: [fundo, faixa/figura, tinta do texto]. */
const PALETAS: readonly (readonly [string, string, string])[] = [
  ["#1f3a5f", "#e0a44e", "#f3ebdb"],
  ["#7d2b2b", "#e8d9b5", "#f7efe0"],
  ["#22483c", "#d9b169", "#f1ece0"],
  ["#3d3355", "#c9a227", "#efe9dd"],
  ["#8a4b1e", "#f0dfc0", "#fff8ec"],
  ["#14313a", "#8fc7c0", "#eef6f4"],
  ["#4a2140", "#d98cae", "#f6ecf2"],
];

/** Hash estável (djb2) — mesmo id, mesma capa, execução após execução. */
function hashDoId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 33) ^ id.charCodeAt(i);
  }
  return Math.abs(h);
}

/** Escapa o que quebraria o XML da capa (título e autor vêm de texto livre). */
function escaparXml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Quebra o título em até 3 linhas de ~16 caracteres, sem cortar palavra. */
function quebrarEmLinhas(texto: string): string[] {
  const palavras = texto.split(" ");
  const linhas: string[] = [];
  let atual = "";
  for (const palavra of palavras) {
    const tentativa = atual ? `${atual} ${palavra}` : palavra;
    if (tentativa.length > 16 && atual) {
      linhas.push(atual);
      atual = palavra;
    } else {
      atual = tentativa;
    }
  }
  if (atual) linhas.push(atual);
  return linhas.slice(0, 3);
}

/**
 * Capa fictícia 2:3 (240×360) com título, autor e uma figura geométrica que
 * varia por livro. Devolve `data:` URI pronto para `coverFileName`.
 */
export function capaDeFixture(id: string, titulo: string, autor: string | null): string {
  const h = hashDoId(id);
  const [fundo, figura, tinta] = PALETAS[h % PALETAS.length];
  const variante = h % 3;

  const ornamento =
    variante === 0
      ? `<circle cx='120' cy='250' r='58' fill='${figura}' opacity='0.85'/>`
      : variante === 1
        ? `<rect x='36' y='214' width='168' height='72' fill='${figura}' opacity='0.85'/>`
        : `<path d='M120 190 L196 300 L44 300 Z' fill='${figura}' opacity='0.85'/>`;

  const linhas = quebrarEmLinhas(titulo);
  const tituloSvg = linhas
    .map(
      (linha, i) =>
        `<text x='120' y='${64 + i * 26}' font-family='Georgia, serif' font-size='21' fill='${tinta}' text-anchor='middle'>${escaparXml(linha)}</text>`,
    )
    .join("");

  const autorSvg = autor
    ? `<text x='120' y='${64 + linhas.length * 26 + 14}' font-family='Georgia, serif' font-size='13' fill='${tinta}' opacity='0.75' text-anchor='middle'>${escaparXml(autor)}</text>`
    : "";

  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='360' viewBox='0 0 240 360'>` +
    `<rect width='240' height='360' fill='${fundo}'/>` +
    `<rect x='0' y='0' width='7' height='360' fill='${figura}' opacity='0.6'/>` +
    ornamento +
    tituloSvg +
    autorSvg +
    `</svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
