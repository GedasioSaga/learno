import type { Decisao, FlechaDaTrilha } from "../../lib/ipc";

/**
 * Traduz uma conexão do `@xyflow/react` (o gesto de arrastar uma alça até
 * outra) para os dois ids que `criarFlecha(blockedId, blockingId, pathLabel)`
 * espera, NA ORDEM CERTA. Extraído de `TrilhaCanvas.tsx` para ser testável sem
 * montar um `<ReactFlow>` e simular um arrasto — a única coisa que
 * realmente importa verificar aqui é a ordem, e trocá-la não gera erro
 * nenhum (o pedido avisa: "inverte a dependência e nada acusa").
 *
 * O handle "source" (direita, pino cheio — `EtapaNode.tsx`) fica em quem
 * BLOQUEIA; o "target" (esquerda, soquete oco) fica em quem é BLOQUEADO.
 *
 * O tipo `Connection` do `@xyflow/react` declara `source`/`target` como
 * `string` (nunca `null`) — este parâmetro é deliberadamente mais permissivo
 * (`string | null` em vez de importar `Connection`), para o `onConnect`
 * de verdade sempre bater com ele e, ainda assim, esta função continuar
 * segura se um dia chegar algo incompleto por outro caminho. Devolve `null`
 * nesse caso, em vez de confiar que "o tipo garante".
 */
export function paresDaFlechaPorConexao(conexao: {
  source: string | null;
  target: string | null;
}): { blockedId: string; blockingId: string } | null {
  if (!conexao.source || !conexao.target) return null;
  return { blockedId: conexao.target, blockingId: conexao.source };
}

/**
 * `true` quando `stepId` é uma decisão — existe uma entrada correspondente em
 * `decisoes`. Não há campo "tipo de etapa": é a EXISTÊNCIA da linha em
 * `Decisao[]` que faz a etapa ramificar (comentário de `Decisao` em
 * `lib/ipc.ts`). Extraída para `argumentosDeCriarFlecha` decidir se uma
 * conexão nova precisa de rótulo, e para `TrilhaCanvas` decidir se pergunta.
 */
export function etapaEhDecisao(stepId: string, decisoes: readonly Decisao[]): boolean {
  return decisoes.some((decisao) => decisao.stepId === stepId);
}

/**
 * O rótulo-sugestão para um caminho NOVO que sai de `blockingId`: "Caminho N",
 * o menor N ainda não usado por nenhuma flecha existente que já sai dessa
 * MESMA decisão. Nunca vazio nem `null` — o contrato marca `pathLabel` como o
 * que faz a flecha ser um RAMO (ver `FlechaDaTrilha` em `lib/ipc.ts`); nascer
 * com `null` faria a flecha nascer como pré-requisito incondicional, o
 * oposto do que arrastar de uma decisão significa. É só a SUGESTÃO inicial do
 * formulário (`TrilhaCanvas.tsx`) — o usuário digita o nome de verdade antes
 * de confirmar, e pode trocar depois com `renomearCaminho`.
 */
export function proximoRotuloDeCaminho(blockingId: string, flechas: readonly FlechaDaTrilha[]): string {
  const usados = new Set(
    flechas
      .filter((flecha): flecha is FlechaDaTrilha & { pathLabel: string } => flecha.blockingId === blockingId && flecha.pathLabel !== null)
      .map((flecha) => flecha.pathLabel),
  );
  let indice = 1;
  while (usados.has(`Caminho ${indice}`)) indice++;
  return `Caminho ${indice}`;
}

/** Os três argumentos que `criarFlecha` espera, já resolvidos a partir de uma conexão. */
export interface ArgumentosDeCriarFlecha {
  blockedId: string;
  blockingId: string;
  /**
   * `null` quando `blockingId` NÃO é uma decisão — pré-requisito
   * incondicional, exatamente como uma flecha comum hoje (arrastar de uma
   * etapa comum não muda). Quando É uma decisão, vem preenchido com a
   * PRÓXIMA sugestão de nome (`proximoRotuloDeCaminho`): quem chama decide
   * se usa a sugestão direto ou pergunta ao usuário antes — esta função só
   * resolve "precisa de rótulo, e qual o próximo nome livre".
   */
  pathLabel: string | null;
}

/**
 * Junta `paresDaFlechaPorConexao` (ordem) com a regra de rótulo (item 3 do
 * pedido): "arrastar de uma decisão cria uma flecha COM rótulo; de uma etapa
 * comum, sem rótulo, como hoje". `null` quando a conexão em si é inválida
 * (mesmo caso de `paresDaFlechaPorConexao`).
 */
export function argumentosDeCriarFlecha(
  conexao: { source: string | null; target: string | null },
  decisoes: readonly Decisao[],
  flechas: readonly FlechaDaTrilha[],
): ArgumentosDeCriarFlecha | null {
  const par = paresDaFlechaPorConexao(conexao);
  if (!par) return null;
  const pathLabel = etapaEhDecisao(par.blockingId, decisoes) ? proximoRotuloDeCaminho(par.blockingId, flechas) : null;
  return { ...par, pathLabel };
}

/**
 * Onde uma flecha está em relação à decisão que a origina — o que
 * `TrilhaCanvas.tsx` usa para desenhar a flecha viva/morta/esperando
 * diferente (item 2 do pedido). Espelha `SituacaoNoCaminho` de `lib/ipc.ts`,
 * mas por FLECHA em vez de por etapa (uma etapa "aguardandoEscolha" pode ter
 * uma flecha de entrada viva e outra esperando — o card da etapa some as
 * duas; o desenho da flecha precisa da granularidade fina).
 *
 * - `viva`: incondicional (`pathLabel === null`), ou o caminho dela é o
 *   ESCOLHIDO da decisão — ela bloqueia de verdade.
 * - `esperando`: tem rótulo, mas a decisão de origem ainda não escolheu
 *   nenhum caminho (`chosenLabel === null`) — nem viva nem morta, em suspenso.
 * - `morta`: tem rótulo, a decisão já escolheu, e o escolhido é OUTRO —
 *   este ramo não bloqueia nada.
 */
export type EstadoDaFlecha = "viva" | "morta" | "esperando";

export function estadoDaFlecha(flecha: FlechaDaTrilha, decisoes: readonly Decisao[]): EstadoDaFlecha {
  if (flecha.pathLabel === null) return "viva";
  const decisao = decisoes.find((candidata) => candidata.stepId === flecha.blockingId);
  if (!decisao || decisao.chosenLabel === null) return "esperando";
  return decisao.chosenLabel === flecha.pathLabel ? "viva" : "morta";
}

/** Acima disto, o rótulo é cortado com reticências no canvas — ver `rotuloDeExibicao`. */
const TAMANHO_MAXIMO_DO_ROTULO_NO_CANVAS = 20;

/**
 * O texto que o rótulo nativo do `@xyflow/react` (prop `label` da aresta)
 * deve mostrar — `undefined` quando não há rótulo (o `<EdgeText>` da lib já
 * não renderiza nada para `label` falsy, então devolver `undefined` em vez de
 * string vazia é o bastante para a flecha ficar sem rótulo nenhum).
 *
 * Corta em `TAMANHO_MAXIMO_DO_ROTULO_NO_CANVAS`: SVG `<text>` não trunca
 * sozinho como `text-overflow` de CSS, e várias flechas saindo da mesma
 * decisão com nomes compridos viram sopa de texto sobreposto — cortar aqui,
 * na fonte do texto, é mais simples que tentar truncar dentro do SVG.
 */
export function rotuloDeExibicao(pathLabel: string | null): string | undefined {
  if (pathLabel === null) return undefined;
  if (pathLabel.length <= TAMANHO_MAXIMO_DO_ROTULO_NO_CANVAS) return pathLabel;
  return `${pathLabel.slice(0, TAMANHO_MAXIMO_DO_ROTULO_NO_CANVAS - 1)}…`;
}
