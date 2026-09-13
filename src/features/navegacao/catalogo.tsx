import type { ComponentType } from "react";
import { SECAO_IDS, type ImplementacaoDaSecao, type MetadadosDaSecao, type Secao, type SecaoId } from "./contrato";
import { EstadoEmConstrucao } from "./EstadoEmConstrucao";
import {
  IconeBiblioteca,
  IconeCartoes,
  IconeCronograma,
  IconeHoje,
  IconeMapaMental,
  IconeNotas,
  IconeTrilha,
} from "./icones";

/**
 * A identidade das sete seções — nome, ícone, o que cada uma é.
 *
 * Só metadado: nenhum componente de tela mora aqui, então este arquivo não
 * muda quando uma seção fica pronta. Quem liga tela a seção é `montarSecoes`,
 * chamado em `src/App.tsx`.
 *
 * `descricao` e `planejado` são o que o usuário vê enquanto a seção não
 * existe. Estão escritos a partir do pedido dele, sem promessa que ninguém
 * combinou — se algo aqui não for construído, é este texto que precisa mudar,
 * não a tela que precisa fingir.
 */
export const CATALOGO_DE_SECOES: Readonly<Record<SecaoId, MetadadosDaSecao>> = {
  hoje: {
    id: "hoje",
    nome: "Hoje",
    resumo: "Por onde começar o dia de estudo.",
    icone: <IconeHoje />,
    descricao:
      "O painel de começo de dia: o Pomodoro para estudar, os cartões que vencem hoje e quantas horas você já estudou na semana — tudo numa tela só, para abrir o app e já saber o que fazer.",
    planejado: [
      "Temporizador Pomodoro com foco e pausas, contando o que foi concluído no dia",
      "Cartões novos, em aprendizado e para revisar hoje, com atalho para estudar",
      "Horas focadas na semana, vindas das sessões de Pomodoro de verdade",
    ],
  },
  notas: {
    id: "notas",
    nome: "Notas",
    resumo: "Categorias, páginas e subpáginas com texto rico.",
    icone: <IconeNotas />,
    descricao:
      "Suas categorias e páginas, com subpáginas, imagens e formatação rica — o caderno do Learno.",
    planejado: [],
  },
  cartoes: {
    id: "cartoes",
    nome: "Cartões",
    resumo: "Baralhos e estudo por repetição espaçada.",
    icone: <IconeCartoes />,
    descricao:
      "Cartões de memória organizados em baralhos, estudados por repetição espaçada: o app decide quando cada cartão volta, você só responde.",
    planejado: [
      "Baralhos em árvore, com contagem de novos, em aprendizado e para revisar",
      "Sessão de estudo com quatro respostas: errei, difícil, bom, fácil",
      "Criar e editar notas com frente, verso e etiquetas",
    ],
  },
  "mapa-mental": {
    id: "mapa-mental",
    nome: "Mapa mental",
    resumo: "Canvas infinito para ligar ideias.",
    icone: <IconeMapaMental />,
    descricao:
      "Um canvas infinito onde cada ideia é um nó e as ligações entre elas são desenhadas à mão — para ver o assunto inteiro de uma vez.",
    planejado: [
      "Criar, mover e ligar nós num canvas com zoom e arrasto",
      "Ligar um nó a uma página de Notas",
      "Vários mapas, cada um com nome próprio",
    ],
  },
  trilha: {
    id: "trilha",
    nome: "Trilha",
    resumo: "O que estudar antes do quê, seguido por flechas.",
    icone: <IconeTrilha />,
    descricao:
      "O fluxo de dependência entre tópicos: o que precisa vir antes do quê, desenhado como um caminho de flechas que você segue enquanto avança.",
    planejado: [
      "Tópicos como pontos ligados por flechas de pré-requisito",
      "Marcar um tópico como dominado e ver o caminho seguinte se abrir",
      "Ligar cada tópico à página de Notas e ao baralho de Cartões dele",
    ],
  },
  cronograma: {
    id: "cronograma",
    nome: "Cronograma",
    resumo: "A semana planejada contra a realizada.",
    icone: <IconeCronograma />,
    descricao:
      "A semana que você planejou lado a lado com a que aconteceu de verdade — sem maquiagem: o realizado vem das sessões de Pomodoro, não de uma caixa marcada à mão.",
    planejado: [
      "Blocos de estudo por dia da semana, arrastáveis",
      "O realizado preenchido pelas sessões de Pomodoro concluídas",
      "A diferença entre planejado e realizado, visível de cara",
    ],
  },
  biblioteca: {
    id: "biblioteca",
    nome: "Biblioteca",
    resumo: "PDFs e EPUBs com progresso de leitura.",
    icone: <IconeBiblioteca />,
    descricao:
      "Seus PDFs e EPUBs num lugar só, com o ponto onde você parou em cada um — para o material de estudo morar junto das notas e dos cartões.",
    planejado: [
      "Importar PDF e EPUB para a pasta de trabalho",
      "Continuar de onde parou, por arquivo",
      "Progresso de leitura por livro",
    ],
  },
};

/** As sete seções, na ordem do rail. */
export const METADADOS_DAS_SECOES: readonly MetadadosDaSecao[] = SECAO_IDS.map((id) => CATALOGO_DE_SECOES[id]);

/**
 * Atalho de teclado de uma seção: Ctrl+1 … Ctrl+7, pela ordem do rail.
 * `null` para uma seção fora da ordem conhecida (não acontece com o catálogo,
 * mas o tipo não garante).
 */
export function atalhoDaSecao(id: SecaoId): number | null {
  const indice = SECAO_IDS.indexOf(id);
  return indice === -1 ? null : indice + 1;
}

function placeholderPara(metadados: MetadadosDaSecao): ComponentType {
  function SecaoEmConstrucao() {
    return (
      <EstadoEmConstrucao
        nome={metadados.nome}
        descricao={metadados.descricao}
        planejado={metadados.planejado}
        icone={metadados.icone}
      />
    );
  }
  SecaoEmConstrucao.displayName = `SecaoEmConstrucao(${metadados.id})`;
  return SecaoEmConstrucao;
}

/**
 * Liga tela a seção. É a única coisa que `src/App.tsx` precisa fazer para
 * uma seção nova aparecer: passar `{ cartoes: { Painel, Conteudo } }`.
 *
 * Seção sem implementação não some do rail — ganha o `EstadoEmConstrucao`
 * com o texto do catálogo. É de propósito: o usuário vê o app inteiro que
 * pediu, e cada aba diz com honestidade o que ainda falta.
 */
export function montarSecoes(implementacoes: Partial<Record<SecaoId, ImplementacaoDaSecao>>): readonly Secao[] {
  return METADADOS_DAS_SECOES.map((metadados) => {
    const implementacao = implementacoes[metadados.id];
    if (!implementacao) {
      return { ...metadados, estado: "em-construcao", Painel: null, Conteudo: placeholderPara(metadados) };
    }
    return {
      ...metadados,
      estado: "pronta",
      Painel: implementacao.Painel ?? null,
      Conteudo: implementacao.Conteudo,
    };
  });
}
