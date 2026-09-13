/**
 * Dinheiro e mês na seção Finanças.
 *
 * Todo valor trafega como CENTAVOS inteiros (`valorCentavos`), igual ao banco
 * (`0043_financas.sql`). Nunca `number` de reais com casa decimal: 0,1 + 0,2
 * em ponto flutuante não é 0,3, e uma sobra do mês não pode errar por um
 * centavo que ninguém gastou.
 *
 * Mês é `YYYY-MM` — um mês do calendário da pessoa, não um instante. Mesmo
 * cuidado de `cronograma/date-utils.ts`: nada aqui passa por `new Date(iso)`
 * puro, que leria a string como UTC e poderia cair no mês anterior.
 */

const FORMATADOR_REAIS = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const FORMATADOR_MES = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const FORMATADOR_MES_CURTO = new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" });

/** Teto defensivo: R$ 100 bilhões. Acima disso é erro de digitação, não salário. */
const MAX_CENTAVOS = 10_000_000_000_000;

const PADRAO_MES = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `412345` → `"R$ 4.123,45"`. */
export function formatarReais(centavos: number): string {
  return FORMATADOR_REAIS.format(centavos / 100);
}

/**
 * Lê o que a pessoa digitou num campo de valor e devolve centavos, ou `null`
 * quando o texto não é um valor válido.
 *
 * Aceita o jeito brasileiro (`1.234,56`, `1234,56`, `R$ 50`) e também ponto
 * decimal quando não há ambiguidade (`1234.5`). `1.234` sem vírgula é mil
 * duzentos e trinta e quatro reais — ponto seguido de três dígitos é milhar
 * no pt-BR. Negativo é recusado: quem diz se o dinheiro entra ou sai é o
 * tipo do lançamento, não o sinal.
 *
 * A conversão é feita sobre os dígitos, sem `parseFloat`, para `0,29` virar
 * exatamente 29 centavos.
 */
export function lerReais(texto: string): number | null {
  const limpo = texto.replace(/R\$/gi, "").replace(/\s/g, "");
  if (limpo === "" || limpo.includes("-")) return null;

  let inteiro: string;
  let decimal: string;
  if (limpo.includes(",")) {
    const partes = limpo.split(",");
    if (partes.length !== 2) return null;
    const [parteInteira, parteDecimal] = partes;
    if (!/^(\d{1,3}(\.\d{3})+|\d+)$/.test(parteInteira)) return null;
    inteiro = parteInteira.replace(/\./g, "");
    decimal = parteDecimal;
  } else if (/^\d{1,3}(\.\d{3})+$/.test(limpo)) {
    inteiro = limpo.replace(/\./g, "");
    decimal = "";
  } else {
    const partes = limpo.split(".");
    if (partes.length > 2) return null;
    inteiro = partes[0];
    decimal = partes[1] ?? "";
  }

  if (!/^\d+$/.test(inteiro) || !/^\d{0,2}$/.test(decimal)) return null;
  const centavos = Number(inteiro) * 100 + Number(decimal.padEnd(2, "0"));
  return centavos > MAX_CENTAVOS ? null : centavos;
}

/** Mesma validação do Rust (`parse_mes`): `YYYY-MM` com mês de 01 a 12. */
export function ehMesValido(mes: string): boolean {
  return PADRAO_MES.test(mes);
}

function partesDoMes(mes: string): [number, number] {
  const encontrado = PADRAO_MES.exec(mes);
  if (!encontrado) throw new Error(`Mês inválido: ${mes}`);
  return [Number(encontrado[1]), Number(encontrado[2])];
}

function montarMes(ano: number, mes: number): string {
  return `${ano}-${String(mes).padStart(2, "0")}`;
}

/** O mês de hoje no relógio local. */
export function mesDe(data: Date): string {
  return montarMes(data.getFullYear(), data.getMonth() + 1);
}

/** `deslocarMes("2026-12", 1)` → `"2027-01"`. Aceita deslocamento negativo. */
export function deslocarMes(mes: string, deslocamento: number): string {
  const [ano, numero] = partesDoMes(mes);
  const indice = ano * 12 + (numero - 1) + deslocamento;
  return montarMes(Math.floor(indice / 12), (indice % 12) + 1);
}

/** `"2026-09"` → `"setembro de 2026"`. */
export function rotuloDoMes(mes: string): string {
  const [ano, numero] = partesDoMes(mes);
  return FORMATADOR_MES.format(new Date(ano, numero - 1, 1));
}

/** `"2026-09"` → `"set. de 26"`, para tabela. */
export function rotuloCurtoDoMes(mes: string): string {
  const [ano, numero] = partesDoMes(mes);
  return FORMATADOR_MES_CURTO.format(new Date(ano, numero - 1, 1));
}

/** Primeiro dia do mês, `YYYY-MM-DD` — a data padrão de um lançamento novo. */
export function primeiroDiaDoMes(mes: string): string {
  partesDoMes(mes);
  return `${mes}-01`;
}

/** `"2026-09-30"` → `"30/09/2026"`, sem passar por `Date`. */
export function formatarDataLocal(dataLocal: string): string {
  const [ano, mes, dia] = dataLocal.split("-");
  return `${dia}/${mes}/${ano}`;
}
