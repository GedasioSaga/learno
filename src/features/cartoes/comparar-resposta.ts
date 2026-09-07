export type StatusDoCaractere = "certo" | "errado" | "faltando" | "sobrando";

export type PedacoDaComparacao = { status: StatusDoCaractere; texto: string };

export type ResultadoDaComparacao = { acertou: boolean; pedacos: PedacoDaComparacao[] };

// U+0300..U+036F = bloco Unicode "Combining Diacritical Marks": é nisso que
// vira todo acento (agudo, til, cedilha etc.) depois de `normalize("NFD")`
// separar a letra base da marca. Construído por código-ponto, em vez de
// colar a marca combinante literal direto na regex, porque um caractere
// combinante solto na própria fonte é ilegível e frágil a qualquer
// reformatação do arquivo — o código-ponto numérico não tem esse risco.
const CODIGO_MARCA_COMBINANTE_INICIO = 0x0300;
const CODIGO_MARCA_COMBINANTE_FIM = 0x036f;
const REGEX_MARCA_COMBINANTE = new RegExp(
  `[${String.fromCharCode(CODIGO_MARCA_COMBINANTE_INICIO)}-${String.fromCharCode(CODIGO_MARCA_COMBINANTE_FIM)}]`,
  "g",
);

/**
 * "Digitar a resposta" não pode exigir acento e espaçamento perfeitos — quem
 * sabe a resposta e erra só a pontuação não pode ser marcado como errado.
 * Por isso comparamos acerto/erro numa versão normalizada (sem acento, sem
 * caixa, sem espaço redundante), mas o diff visual usa o texto ORIGINAL: o
 * usuário precisa ver exatamente onde a caixa ou o acento saiu diferente,
 * mesmo quando a resposta contou como certa.
 */
function normalizar(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(REGEX_MARCA_COMBINANTE, "");
}

type TipoDeOperacao = "igual" | "apagar" | "inserir";

type OperacaoLcs = { tipo: TipoDeOperacao; caractere: string };

/**
 * Diff de caractere por maior subsequência comum (programação dinâmica).
 * `dp[i][j]` = tamanho da LCS entre `esperado[i:]` e `digitado[j:]`; calculado
 * de trás para frente para permitir reconstruir o caminho andando para
 * frente (sem precisar inverter array no final). Resposta de estudo tem
 * dezenas de caracteres, não milhares — O(n·m) é suficiente, Myers seria
 * over-engineering aqui.
 */
function computarOperacoesLcs(esperado: string, digitado: string): OperacaoLcs[] {
  const n = esperado.length;
  const m = digitado.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        esperado[i] === digitado[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const operacoes: OperacaoLcs[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (esperado[i] === digitado[j]) {
      operacoes.push({ tipo: "igual", caractere: esperado[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      operacoes.push({ tipo: "apagar", caractere: esperado[i] }); // esperado tem, digitado não
      i++;
    } else {
      operacoes.push({ tipo: "inserir", caractere: digitado[j] }); // digitado tem a mais
      j++;
    }
  }
  while (i < n) {
    operacoes.push({ tipo: "apagar", caractere: esperado[i] });
    i++;
  }
  while (j < m) {
    operacoes.push({ tipo: "inserir", caractere: digitado[j] });
    j++;
  }
  return operacoes;
}

type BlocoDeOperacao = { tipo: TipoDeOperacao; texto: string };

/** Funde operações consecutivas do mesmo tipo — passo prévio à fusão final de pedaços por status. */
function agruparBlocosConsecutivos(operacoes: OperacaoLcs[]): BlocoDeOperacao[] {
  const blocos: BlocoDeOperacao[] = [];
  for (const operacao of operacoes) {
    const ultimo = blocos[blocos.length - 1];
    if (ultimo && ultimo.tipo === operacao.tipo) {
      ultimo.texto += operacao.caractere;
    } else {
      blocos.push({ tipo: operacao.tipo, texto: operacao.caractere });
    }
  }
  return blocos;
}

/**
 * Um bloco "apagar" (falta no digitado) colado num bloco "inserir" (sobra no
 * digitado), em qualquer ordem, é uma TROCA do ponto de vista de quem
 * digitou — não duas coisas erradas separadas. Vira um único pedaço
 * "errado" cujo texto é sempre o lado DIGITADO (o "inserir"), nunca o
 * esperado: é isso que garante a invariante documentada em
 * `compararResposta` (concatenar tudo que não é "faltando" reproduz o
 * digitado), mesmo quando os dois blocos têm comprimentos diferentes.
 */
function combinarTrocasAdjacentes(blocos: BlocoDeOperacao[]): PedacoDaComparacao[] {
  const pedacos: PedacoDaComparacao[] = [];
  let i = 0;
  while (i < blocos.length) {
    const atual = blocos[i];
    const proximo = blocos[i + 1];
    const formamTroca =
      proximo !== undefined &&
      atual.tipo !== "igual" &&
      proximo.tipo !== "igual" &&
      atual.tipo !== proximo.tipo;

    if (formamTroca) {
      const textoDigitado = atual.tipo === "inserir" ? atual.texto : proximo.texto;
      pedacos.push({ status: "errado", texto: textoDigitado });
      i += 2;
      continue;
    }

    const status: StatusDoCaractere =
      atual.tipo === "igual" ? "certo" : atual.tipo === "apagar" ? "faltando" : "sobrando";
    pedacos.push({ status, texto: atual.texto });
    i += 1;
  }
  return pedacos;
}

/**
 * Duas trocas adjacentes (ex.: apagar+inserir seguido de outro apagar+inserir)
 * viram dois pedaços "errado" vizinhos em `combinarTrocasAdjacentes` — esta
 * função os funde num só, e também funde qualquer "certo"/"faltando"/"sobrando"
 * que tenha sobrado colado ao vizinho de mesmo status. A tela nunca deve
 * receber um pedaço por caractere quando eles se seguem.
 */
function mesclarPedacosAdjacentes(pedacos: PedacoDaComparacao[]): PedacoDaComparacao[] {
  const mesclados: PedacoDaComparacao[] = [];
  for (const pedaco of pedacos) {
    const ultimo = mesclados[mesclados.length - 1];
    if (ultimo && ultimo.status === pedaco.status) {
      ultimo.texto += pedaco.texto;
    } else {
      mesclados.push({ status: pedaco.status, texto: pedaco.texto });
    }
  }
  return mesclados;
}

/**
 * Compara a resposta digitada com a esperada, para o cartão do tipo "Digitar
 * a resposta". `acertou` usa a forma normalizada (ver `normalizar`); os
 * `pedacos` são o diff caractere a caractere sobre o texto ORIGINAL, para a
 * tela destacar exatamente onde a caixa/acento/letra saiu diferente mesmo
 * numa resposta que contou como certa.
 *
 * Invariante garantida (é o que a tela pode assumir ao renderizar pedaço por
 * pedaço): concatenar o `texto` de todo pedaço com status diferente de
 * "faltando", na ordem em que aparecem, reproduz exatamente `digitado`.
 * Não garantimos a invariante simétrica do lado do `esperado` — juntar
 * "certo" + "faltando" + o texto esperado de cada "errado" exigiria guardar
 * os dois lados de cada troca, o que não serve para nada aqui: a tela só
 * precisa mostrar o que o usuário digitou.
 */
export function compararResposta(esperado: string, digitado: string): ResultadoDaComparacao {
  const acertou = normalizar(esperado) === normalizar(digitado);
  const operacoes = computarOperacoesLcs(esperado, digitado);
  const blocos = agruparBlocosConsecutivos(operacoes);
  const pedacos = mesclarPedacosAdjacentes(combinarTrocasAdjacentes(blocos));
  return { acertou, pedacos };
}
