import { useState, type DragEvent } from "react";
import type { LivroNaEstante } from "../../lib/ipc";
import { LivroCard } from "./LivroCard";
import { useBibliotecaStore } from "./store";

interface GradeDeLivrosProps {
  livros: LivroNaEstante[];
  onAbrir: (livroId: string) => void;
  onRemover: (livroId: string) => void;
}

/**
 * A grade de livros propriamente dita — reaproveitada tanto para a grade
 * "lisa" (sem agrupamento: nenhuma categoria criada ainda, ou um filtro de
 * categoria específico ativo) quanto para CADA subgrupo da estante agrupada
 * por categoria/subcategoria (`ConteudoDeBiblioteca.tsx`).
 *
 * Arrastar e soltar é a MESMA técnica de `PageTree`/`PageTreeItem`
 * (drag nativo do HTML5 em `<li draggable>`, sem lib — proibido instalar
 * uma). "Mover para cima"/"para baixo" no cartão (`LivroCard`) é o caminho
 * de TECLADO equivalente: regra dura de acessibilidade do pedido — arrastar
 * com o mouse nunca pode ser o único jeito de reordenar. Os dois caminhos
 * terminam na mesma chamada, `moverLivro(id, aposLivroId)`.
 *
 * DEPENDE DE `"dragDropEnabled": false` EM `src-tauri/tauri.conf.json`, e
 * essa linha não é sobra: com o padrão (`true`), o Tauri registra no WebView2
 * o manipulador de arrastar-arquivo do sistema operacional, que intercepta o
 * gesto ANTES de a página vê-lo. O sintoma é o cursor de proibido e nenhum
 * `drop` — e nenhuma correção em JavaScript resolve, porque o evento não
 * chega. Nada neste app usa arrastar-arquivo-de-fora (importar livro abre um
 * seletor de arquivo), então desligar não custa nada. Quem reativar aquela
 * linha quebra o arrastar daqui e o da árvore de páginas junto.
 *
 * ORDEM GLOBAL, NÃO POR GRUPO: o backend guarda UMA posição por livro
 * (`library_books.position`) — não existe "ordem só dentro de Fantasia".
 * Arrastar dentro de UM grupo (os dois "Percy Jackson" de "Fantasia >
 * Épico", por exemplo) ainda assim reordena a ESTANTE inteira — só que o
 * alvo (`aposLivroId`) é sempre o vizinho DESTE grupo/desta grade, o que faz
 * a ordem dentro do grupo virar exatamente o que o usuário pediu, sem
 * precisar tocar em nenhum livro de outro grupo. Efeito colateral aceito e
 * documentado (o hint em `ConteudoDeBiblioteca.tsx` avisa isso na tela): não
 * existe uma ordem "esquecida" quando o agrupamento muda ou quando o filtro
 * de categoria liga/desliga, porque só existe UMA ordem — a mesma em
 * qualquer recorte da estante.
 */
export function GradeDeLivros({ livros, onAbrir, onRemover }: GradeDeLivrosProps) {
  const moverLivro = useBibliotecaStore((state) => state.moverLivro);
  const [arrastandoId, setArrastandoId] = useState<string | null>(null);
  const [alvoDoArrasto, setAlvoDoArrasto] = useState<{ id: string; lado: "antes" | "depois" } | null>(null);

  // Mesmo cálculo de `dropPositionRelativeToSibling`/`computeKeyboardMove`
  // em `features/pages/tree-utils.ts` ("reorder-up"/"reorder-down"): subir
  // um lugar pousa logo depois de quem estava DOIS acima (ou no início, se
  // não houver um segundo vizinho); descer pousa logo depois do vizinho de
  // baixo. `livros` aqui é só a lista VISÍVEL nesta grade (o grupo inteiro,
  // ou a estante lisa) — o limite de topo/fim é o desta grade, não da
  // estante inteira, do mesmo jeito que "irmãos" limita o Alt+seta da
  // árvore de páginas ao mesmo pai.
  function aposLivroIdParaCima(indice: number): string | null {
    return indice - 2 >= 0 ? livros[indice - 2].livro.id : null;
  }

  function aposLivroIdParaBaixo(indice: number): string {
    return livros[indice + 1].livro.id;
  }

  /**
   * Em qual METADE do cartão o ponteiro está — e por que isso decide tudo.
   *
   * Antes, soltar sobre um cartão significava sempre "pousa logo DEPOIS
   * dele". Num par de livros isso torna metade dos gestos inúteis: arrastar
   * o segundo sobre o primeiro pede "põe o segundo depois do primeiro", que
   * é exatamente onde ele já está. Nada mudava, e o usuário lia isso como
   * recusa — "com um lado deixa, com o outro não".
   *
   * A grade quebra linha, mas flui da esquerda para a direita: horizontal É
   * o eixo natural aqui (o comentário antigo dizia que não havia um, e estava
   * errado). Metade esquerda = antes do alvo; metade direita = depois.
   */
  function ladoDoCartao(event: DragEvent<HTMLLIElement>): "antes" | "depois" {
    const retangulo = event.currentTarget.getBoundingClientRect();
    return event.clientX < retangulo.left + retangulo.width / 2 ? "antes" : "depois";
  }

  /**
   * Traduz "soltei deste lado do cartão X" para o `aposLivroId` que o backend
   * entende — ele só sabe posicionar DEPOIS de alguém (ou em primeiro, com
   * `null`). Soltar ANTES do alvo é o mesmo que pousar depois do vizinho
   * anterior a ele; se o alvo for o primeiro da grade, é pousar em primeiro.
   */
  function aposIdParaSoltarEm(alvoId: string, lado: "antes" | "depois"): string | null {
    if (lado === "depois") return alvoId;
    const indiceDoAlvo = livros.findIndex((item) => item.livro.id === alvoId);
    return indiceDoAlvo > 0 ? livros[indiceDoAlvo - 1].livro.id : null;
  }

  function handleDragStart(id: string, event: DragEvent<HTMLLIElement>) {
    setArrastandoId(id);
    // Firefox recusa iniciar um arraste sem dado nenhum em `dataTransfer` —
    // mesmo motivo do comentário em `PageTree.handleDragStart`.
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
  }

  /**
   * `preventDefault` autoriza o `drop` no HTML5 DnD — sem isto o navegador
   * trata o alvo como não aceitável e mostra o cursor de proibido.
   *
   * Ele roda ANTES de qualquer decisão sobre o alvo, e a razão é uma armadilha
   * de tempo: `arrastandoId` é estado do React, escrito em `dragstart`. Os
   * primeiros `dragover` chegam antes de o React re-renderizar, então o
   * guarda ainda lê `null` e saía sem autorizar — o gesto nascia proibido, e
   * era o que o usuário via. Autorizar sempre e usar o estado só para o
   * DESTAQUE separa as duas coisas: o que o navegador precisa saber na hora,
   * e o que a tela precisa desenhar depois.
   */
  function handleDragOver(id: string, event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!arrastandoId || arrastandoId === id) return;
    setAlvoDoArrasto({ id, lado: ladoDoCartao(event) });
  }

  function handleDragLeave(id: string) {
    setAlvoDoArrasto((atual) => (atual?.id === id ? null : atual));
  }

  function handleDrop(id: string, event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    const arrastado = arrastandoId;
    setArrastandoId(null);
    setAlvoDoArrasto(null);
    if (!arrastado || arrastado === id) return;

    const apos = aposIdParaSoltarEm(id, ladoDoCartao(event));
    // Soltar logo depois de onde o livro já está é um pedido sem efeito —
    // não uma recusa. Sair aqui evita uma ida ao banco que não mudaria nada.
    if (apos === arrastado) return;
    void moverLivro(arrastado, apos);
  }

  function handleDragEnd() {
    setArrastandoId(null);
    setAlvoDoArrasto(null);
  }

  return (
    // Coluna adaptativa: quantas capas de 10rem couberem, com calha fixa
    // de 16px. Numa janela de 1440px dá sete colunas de ~180px — a escala
    // de estante (Apple Books, Calibre), não de pôster: capa grande demais
    // deixa a segunda fila fora da tela e a estante vira rolagem.
    <ul
      data-slot="grade-de-livros"
      className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-7"
    >
      {livros.map((item, indice) => (
        <li
          key={item.livro.id}
          draggable
          onDragStart={(event) => handleDragStart(item.livro.id, event)}
          // `dragenter` autoriza junto com `dragover`: alguns navegadores
          // decidem se o alvo aceita o drop já na ENTRADA, antes do primeiro
          // `dragover`. Sem ele o cursor pisca no sinal de proibido ao cruzar
          // a borda do cartão.
          onDragEnter={(event) => handleDragOver(item.livro.id, event)}
          onDragOver={(event) => handleDragOver(item.livro.id, event)}
          onDragLeave={() => handleDragLeave(item.livro.id)}
          onDrop={(event) => handleDrop(item.livro.id, event)}
          onDragEnd={handleDragEnd}
          // A marca fica no LADO onde o livro vai cair, não em volta do cartão
          // inteiro: contorno diz "é este alvo", mas não diz de que lado — e o
          // lado é justamente a informação que faltava.
          //
          // O cartão sendo arrastado fica meio transparente: é a única
          // resposta visual de que o gesto pegou — sem ela, o fantasma
          // nativo do navegador é tudo o que o usuário vê.
          className={`rounded-sm px-1 transition-opacity ${arrastandoId === item.livro.id ? "opacity-50" : ""} ${
            alvoDoArrasto?.id === item.livro.id
              ? alvoDoArrasto.lado === "antes"
                ? "border-l-2 border-emerald"
                : "border-r-2 border-emerald"
              : "border-l-2 border-r-2 border-transparent"
          }`}
        >
          <LivroCard
            item={item}
            onAbrir={() => onAbrir(item.livro.id)}
            onRemover={() => onRemover(item.livro.id)}
            podeMoverParaCima={indice > 0}
            podeMoverParaBaixo={indice < livros.length - 1}
            onMoverParaCima={() => void moverLivro(item.livro.id, aposLivroIdParaCima(indice))}
            onMoverParaBaixo={() => void moverLivro(item.livro.id, aposLivroIdParaBaixo(indice))}
          />
        </li>
      ))}
    </ul>
  );
}
