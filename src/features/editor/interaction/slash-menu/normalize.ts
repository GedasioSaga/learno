/**
 * Normaliza texto pra comparação insensível a acento (EDT-047): o app é em
 * português, então "titulo" precisa achar "Título" no filtro do menu "/".
 * `NFD` decompõe "í" em "i" + combining acute; removendo a marca de
 * combinação sobra só o "i" - sem tabela de substituição por idioma.
 */
const DIACRITIC_MARKS = /[̀-ͯ]/g;

export function normalizeForSearch(value: string): string {
  return value.normalize("NFD").replace(DIACRITIC_MARKS, "").toLowerCase();
}
