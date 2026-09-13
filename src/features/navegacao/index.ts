/**
 * A navegação do app: o contrato de seção, o catálogo das sete, a store da
 * seção ativa e o estado "em construção".
 *
 * Quem escreve uma seção importa daqui `ImplementacaoDaSecao` (a forma do que
 * entrega), `EstadoEmConstrucao` (para o pedaço que ainda falta) e
 * `useNavegacaoStore` (para mandar o app a outra seção — "abrir a página
 * ligada a este nó" é `irPara("notas")` + selecionar a página na store dela).
 */
export {
  SECAO_IDS,
  ehSecaoId,
  type EstadoDaSecao,
  type ImplementacaoDaSecao,
  type MetadadosDaSecao,
  type Secao,
  type SecaoId,
} from "./contrato";
export { CATALOGO_DE_SECOES, METADADOS_DAS_SECOES, atalhoDaSecao, montarSecoes } from "./catalogo";
export { SECAO_PADRAO, lerPersistido, useNavegacaoStore, type OrigemDaTroca } from "./store";
export { EstadoEmConstrucao } from "./EstadoEmConstrucao";
export { Rail } from "./Rail";
export { ConteudoDeNotas, PainelDeNotas } from "./secao-notas";
export * from "./icones";
