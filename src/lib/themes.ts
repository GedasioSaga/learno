/**
 * O catálogo de temas — quem existe, como se chama, e se é claro ou escuro.
 *
 * O que este arquivo deliberadamente NÃO tem: cor nenhuma. As cores de cada
 * tema vivem só em `src/styles/theme.css`, num bloco `[data-theme="<id>"]`
 * por tema. Duplicar os hex aqui para desenhar as amostras da tela de
 * Aparência criaria duas fontes da verdade, e a segunda ficaria para trás na
 * primeira vez que alguém acertasse um contraste no CSS.
 *
 * Como as amostras se pintam sem hex em TypeScript: o seletor de tema é
 * `[data-theme="<id>"]`, não `:root[data-theme="<id>"]`. Um `<div
 * data-theme="grafite">` no meio da página herda o bloco inteiro de tokens, e
 * qualquer coisa tokenizada dentro dele já sai com a cara daquele tema.
 *
 * O backend também não conhece esta lista: `save_theme` valida a FORMA de um
 * id, não o pertencimento (ver `config::validate_theme_id` em
 * `src-tauri/src/config/mod.rs`). Acrescentar um tema é mexer em dois lugares
 * — este arquivo e o CSS — e em nenhum Rust.
 */

/** Se o tema é claro ou escuro. Decide o `color-scheme` da janela e qual
 *  tema "seguir o sistema" resolve. */
export type Aparencia = "clara" | "escura";

export interface Tema {
  /** O que vai para `data-theme` no documento e para o `config.json`. */
  id: string;
  nome: string;
  /** Uma linha, mostrada abaixo do nome na tela de Aparência. */
  descricao: string;
  aparencia: Aparencia;
}

/**
 * Os cinco temas, na ordem em que aparecem na tela de Aparência.
 *
 * A ordem não é alfabética de propósito: o padrão vem primeiro, o claro em
 * seguida (é o outro extremo, e o mais procurado), e o de acessibilidade por
 * último — quem precisa dele procura por ele, quem não precisa não tropeça.
 */
export const TEMAS: readonly Tema[] = [
  {
    id: "ambar-noturno",
    nome: "Âmbar noturno",
    descricao: "Escuro e quente, com âmbar de acento. O padrão do Learno.",
    aparencia: "escura",
  },
  {
    id: "papel",
    nome: "Papel",
    descricao: "Claro, cor de página. Para trabalhar de dia, perto da janela.",
    aparencia: "clara",
  },
  {
    id: "grafite",
    nome: "Grafite",
    descricao: "Escuro e neutro, sem temperatura. Sai da frente do conteúdo.",
    aparencia: "escura",
  },
  {
    id: "meia-noite",
    nome: "Meia-noite",
    descricao: "Escuro e frio, bem contrastado. Para sessão longa à noite.",
    aparencia: "escura",
  },
  {
    id: "alto-contraste",
    nome: "Alto contraste",
    descricao: "Contraste máximo em cada par de cor, para leitura difícil.",
    aparencia: "escura",
  },
] as const;

/**
 * O tema de uma instalação nova.
 *
 * Escolha explícita do usuário: a primeira impressão é sempre a identidade do
 * produto, mesmo numa máquina com o sistema no claro. Quem preferir outra
 * coisa troca em Configurações > Aparência, e a escolha passa a valer para
 * sempre.
 */
export const TEMA_PADRAO = "ambar-noturno";

/** O tema que "seguir o sistema" escolhe quando o sistema está no claro. */
export const TEMA_CLARO_DO_SISTEMA = "papel";

/** E quando está no escuro. */
export const TEMA_ESCURO_DO_SISTEMA = "ambar-noturno";

/**
 * O valor especial que significa "não fixei um tema, siga o sistema
 * operacional". Não é um tema do catálogo — é a ausência de escolha, e por
 * isso não tem cor nem bloco de CSS.
 */
export const SEGUIR_O_SISTEMA = "sistema";

/** O que pode ser gravado como preferência: um id do catálogo, ou seguir o sistema. */
export type PreferenciaDeTema = string;

export function acharTema(id: string): Tema | undefined {
  return TEMAS.find((tema) => tema.id === id);
}

/**
 * Verdadeiro para um valor que dá para gravar como preferência.
 *
 * Usado ao ler o que veio do disco ou do `localStorage`: um valor de uma
 * versão antiga do app (`"dark"`, `"light"`) ou lixo qualquer não pode virar
 * um `data-theme` que não casa nada e deixar o app sem cor.
 */
export function ehPreferenciaValida(valor: unknown): valor is PreferenciaDeTema {
  return typeof valor === "string" && (valor === SEGUIR_O_SISTEMA || acharTema(valor) !== undefined);
}

/**
 * O tema que o sistema operacional pede agora.
 *
 * `matchMedia` pode não existir (jsdom sem stub), e nesse caso a resposta é o
 * claro — a mesma escolha que um navegador faz quando não sabe.
 */
export function temaDoSistema(): string {
  const prefereEscuro = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  return prefereEscuro ? TEMA_ESCURO_DO_SISTEMA : TEMA_CLARO_DO_SISTEMA;
}

/**
 * Traduz a preferência guardada no tema que de fato vai para o documento.
 *
 * Pura de propósito: é a única regra de resolução do app, e dá para testá-la
 * sem DOM além do `matchMedia`.
 */
export function resolverTema(preferencia: PreferenciaDeTema): string {
  if (preferencia === SEGUIR_O_SISTEMA) return temaDoSistema();
  return acharTema(preferencia) ? preferencia : TEMA_PADRAO;
}

/**
 * O outro tema de um par claro/escuro — o que o atalho de alternar usa.
 *
 * Existe porque o menu nativo do app ("Exibir > Alternar tema") manda um
 * pulso sem dizer qual tema, e porque alternar rápido entre claro e escuro
 * continua sendo o gesto mais comum mesmo com cinco temas disponíveis. A
 * regra: de um tema escuro vai para `papel`; de um claro, volta para o último
 * escuro conhecido (ou o padrão).
 */
export function alternarClaroEscuro(temaAtual: string, ultimoEscuro: string = TEMA_PADRAO): string {
  const atual = acharTema(temaAtual);
  if (atual?.aparencia === "escura") return TEMA_CLARO_DO_SISTEMA;
  return acharTema(ultimoEscuro)?.aparencia === "escura" ? ultimoEscuro : TEMA_PADRAO;
}
