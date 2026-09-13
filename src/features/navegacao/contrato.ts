import type { ComponentType, ReactNode } from "react";

/**
 * O contrato de uma seção do app — o que cada tela (Hoje, Notas, Cartões…)
 * implementa para aparecer no rail e ocupar a casca.
 *
 * Existe para que oito telas escritas por pessoas diferentes falem o mesmo
 * dialeto: a casca (`AppShell`) só conhece esta interface, e uma seção só
 * conhece os dois pontos onde pode desenhar — o painel lateral e o conteúdo.
 * Nada aqui sabe de página, deck ou mapa; isso é da store de cada seção.
 *
 * Quem implementa uma seção NÃO edita este arquivo nem o `catalogo.tsx`:
 * escreve seus componentes e os liga em `src/App.tsx` via `montarSecoes`.
 */

/** As oito seções, na ordem em que aparecem no rail. */
export const SECAO_IDS = [
  "hoje",
  "notas",
  "cartoes",
  "mapa-mental",
  "trilha",
  "cronograma",
  "financas",
  "biblioteca",
] as const;

export type SecaoId = (typeof SECAO_IDS)[number];

/**
 * A identidade de uma seção: o que o rail mostra e o que o estado "em
 * construção" conta. Não muda com a implementação — vive no catálogo.
 */
export interface MetadadosDaSecao {
  id: SecaoId;
  /** Como aparece no rail e no cabeçalho do painel. Curto: cabe em 75px. */
  nome: string;
  /** Uma linha, para o `title` do rail e para o cabeçalho de estado vazio. */
  resumo: string;
  /** SVG de 20px em `currentColor` (ver `icones.tsx`) — nunca emoji: o rail tinge o ícone ativo de âmbar, e emoji não tinge. */
  icone: ReactNode;
  /**
   * O que a seção VAI ser, em prosa honesta — é o que `EstadoEmConstrucao`
   * mostra enquanto a tela não existe. Sem dado inventado.
   */
  descricao: string;
  /** Itens planejados, um por linha. Só o que já foi combinado com o usuário. */
  planejado: readonly string[];
}

/**
 * O que uma tela entrega para ocupar a casca.
 *
 * - `Painel` é a barra secundária (256px, rebaixada) ao lado do rail: árvore
 *   de páginas, lista de decks com contadores, lista de mapas. Opcional — Hoje,
 *   Trilha e Cronograma não têm o que listar e usam a largura inteira.
 * - `Conteudo` é a área principal. Obrigatório.
 *
 * Os dois são componentes sem props de propósito: o que está selecionado
 * (página, deck, mapa) mora na store da própria seção, e é assim que o painel
 * e o conteúdo conversam sem passar pela casca.
 */
export interface ImplementacaoDaSecao {
  Painel?: ComponentType;
  Conteudo: ComponentType;
}

export type EstadoDaSecao = "pronta" | "em-construcao";

/** Uma seção montada: identidade + implementação (ou o placeholder honesto). */
export interface Secao extends MetadadosDaSecao {
  estado: EstadoDaSecao;
  Painel: ComponentType | null;
  Conteudo: ComponentType;
}

/** Guarda de tipo para o que vem de fora (localStorage, URL, evento). */
export function ehSecaoId(valor: unknown): valor is SecaoId {
  // `as readonly string[]` só ALARGA a tupla literal para `includes` aceitar
  // uma string qualquer — sem ele TS exige que o argumento já seja `SecaoId`,
  // que é justamente o que esta função decide. Não afirma nada que não seja.
  return typeof valor === "string" && (SECAO_IDS as readonly string[]).includes(valor);
}
