/**
 * Paleta de cor por ramo do mapa mental (radial): o filho herda a cor do
 * ramo do pai, e os filhos diretos da raiz (que não têm cor própria) recebem
 * uma cor nova cada, ciclando por esta lista na ordem em que nascem — ver
 * `proximaCorDeRamo` e `criarFilhoDe` em `store.ts`.
 *
 * Só entram aqui tokens de `src/styles/theme.css` medidos ≥ 3:1 (WCAG,
 * luminância relativa) contra `--paper` E `--surface` nos CINCO temas — é o
 * que este arquivo usa para BORDA e ARESTA (`mapa-mental.css`), nunca para
 * texto (ver por quê abaixo). Cálculo feito nesta tarefa a partir dos hex de
 * cada tema; os cinco tokens de marca (amber/mint/emerald/terracotta/brown)
 * passaram direto, mas das cinco matizes "sem marca" (`--matiz-*`) só
 * `azul`, `roxo` e `vermelho` passaram — `amarelo` mede 1.62:1 contra
 * `--paper` no tema Papel (bem abaixo de 3:1) e `verde` mede 1.92:1 no mesmo
 * tema; os dois ficaram de fora. `mint` já cobre o verde da marca (3.08:1,
 * o mais apertado da lista, mas ainda ≥ 3:1) — perder `verde` não perde a
 * cor, só a segunda tonalidade dela.
 *
 * O TEXTO do cartão nunca muda de cor com o ramo — fica sempre `--ink`
 * (≥ 4.5:1 contra paper/surface por definição de `theme.css`, em todo
 * tema). Só borda, aresta e um verniz leve do fundo usam a cor do ramo, e é
 * por isso que o requisito de 4.5:1 no texto do nó vale de graça: nenhuma
 * das oito cores abaixo tem uma variante "-ink" própria (só amber/mint/
 * terracotta têm), então usá-las como texto exigiria medir mais três
 * variantes que não existem. Manter o texto neutro evita essa medição e evita
 * qualquer risco de falhar 4.5:1 num tema que não foi conferido.
 */
export const PALETA_DE_RAMOS = [
  "amber",
  "mint",
  "azul",
  "terracotta",
  "roxo",
  "emerald",
  "vermelho",
  "brown",
] as const;

export type CorDeRamo = (typeof PALETA_DE_RAMOS)[number];

function corDeRamoValida(valor: string | null | undefined): valor is CorDeRamo {
  // `.some(...)`, não `.includes(valor)`: `includes` num tuple tipado como
  // `readonly CorDeRamo[]` exige um argumento já do tipo `CorDeRamo`, e
  // `valor` aqui é `string` — teria que castar. Comparar com `===` dentro
  // de `some` não tem essa exigência (comparar union literal com `string`
  // por igualdade é permitido), então resolve sem escape hatch nenhum.
  return valor != null && PALETA_DE_RAMOS.some((cor) => cor === valor);
}

/**
 * A cor do próximo filho de um nó: herda a cor do pai se o pai já tiver uma
 * (mantém o ramo inteiro na mesma cor, do jeito que um mapa radial precisa
 * pra ser legível); se o pai não tiver cor (é a raiz, ou um nó órfão criado
 * pelo "+ Cartão"), o filho vira a raiz de um ramo novo e recebe a próxima
 * cor da paleta, ciclando pelo número de filhos que o pai já tem — é assim
 * que os filhos diretos da raiz saem com cores diferentes entre si.
 */
export function proximaCorDeRamo(
  corDoPai: string | null | undefined,
  numFilhosDoPaiAntes: number,
): CorDeRamo {
  if (corDeRamoValida(corDoPai)) return corDoPai;
  return PALETA_DE_RAMOS[numFilhosDoPaiAntes % PALETA_DE_RAMOS.length];
}
