import { useEffect, useRef, useState, type SVGProps } from "react";
import { AppError, type LivroNaEstante } from "../../lib/ipc";
import { resolveMediaSrc } from "../editor/blocks/media/media-storage";
import { useBibliotecaStore } from "./store";
import "./biblioteca.css";

interface LivroCardProps {
  item: LivroNaEstante;
  onAbrir: () => void;
  onRemover: () => void;
  /** `false` quando o cartão já é o primeiro/último da grade ONDE ELE ESTÁ (o grupo, ou a estante lisa) — ver o comentário de `GradeDeLivros`. */
  podeMoverParaCima: boolean;
  podeMoverParaBaixo: boolean;
  onMoverParaCima: () => void;
  onMoverParaBaixo: () => void;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

interface CampoDeTextoInlineProps {
  rotulo: string;
  placeholder?: string;
  valorInicial: string;
  onConfirmar: (valor: string) => Promise<boolean>;
  onCancelar: () => void;
}

/**
 * Mesmo RACIOCÍNIO de `CampoDeNomeInline` (`PainelDeBiblioteca.tsx`, que
 * acabou de estabelecer este padrão para a Biblioteca): Enter confirma,
 * Escape cancela, blur confirma — sem "Salvar/Cancelar" em texto.
 *
 * Não é o MESMO componente (duplicado aqui, não importado): além de
 * `PainelDeBiblioteca.tsx` estar fora do escopo desta peça, a semântica de
 * "campo vazio" diverge das duas — lá (renomear categoria), vazio CANCELA
 * sem chamar o backend; aqui, vazio é uma confirmação VÁLIDA: apaga o
 * metadado salvo e a estante volta a mostrar o título/autor derivado do
 * arquivo (ver `confirmarEdicaoDeTitulo`/`confirmarEdicaoDeAutor` abaixo).
 */
function CampoDeTextoInline({ rotulo, placeholder, valorInicial, onConfirmar, onCancelar }: CampoDeTextoInlineProps) {
  const [valor, setValor] = useState(valorInicial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Depois que o campo fechou (confirmou ou cancelou), um blur atrasado do
  // desmonte não pode confirmar de novo; e enquanto uma confirmação está em
  // voo, Enter repetido não dispara uma segunda — mesma guarda de
  // `CampoDeNomeInline`.
  const fechadoRef = useRef(false);
  const emVooRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function confirmar() {
    if (fechadoRef.current || emVooRef.current) return;
    emVooRef.current = true;
    try {
      const fechou = await onConfirmar(valor.trim());
      if (fechou) fechadoRef.current = true;
    } finally {
      emVooRef.current = false;
    }
  }

  function cancelar() {
    if (fechadoRef.current) return;
    fechadoRef.current = true;
    onCancelar();
  }

  return (
    <input
      ref={inputRef}
      value={valor}
      onChange={(event) => setValor(event.currentTarget.value)}
      onBlur={() => void confirmar()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void confirmar();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelar();
        }
        // Não deixa Enter/Escape borbulhar para o `<li draggable>` da grade
        // (`GradeDeLivros`) — o campo é modal dentro do cartão enquanto
        // está aberto.
        event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
      placeholder={placeholder}
      aria-label={rotulo}
      className="min-w-0 flex-1 rounded-sm border border-border bg-paper px-1 py-0.5 text-xs text-ink"
    />
  );
}

/**
 * Matizes disponíveis para a capa sintética. As cinco cores de marca mais
 * as duas matizes "sem marca" que `theme.css` já declara (`--matiz-azul`,
 * `--matiz-roxo`) — sete é o suficiente para doze livros vizinhos raramente
 * repetirem cor, sem inventar hex novo. Quem pinta é `biblioteca.css`, por
 * `data-cor`, misturando a matiz com o fundo do tema.
 */
const CORES_DA_CAPA = ["amber", "mint", "emerald", "terracotta", "brown", "azul", "roxo"] as const;
type CorDaCapa = (typeof CORES_DA_CAPA)[number];

/**
 * Cor estável por título: o mesmo livro tem sempre a mesma capa, entre
 * sessões e entre temas. Hash simples de string (o clássico `h * 31 + c`),
 * não criptográfico — só precisa espalhar bem doze títulos por sete cores.
 */
function corDaCapaSintetica(titulo: string): CorDaCapa {
  let hash = 0;
  for (const caractere of titulo) {
    hash = (hash * 31 + (caractere.codePointAt(0) ?? 0)) >>> 0;
  }
  return CORES_DA_CAPA[hash % CORES_DA_CAPA.length];
}

/*
 * Ícones da faixa de ações. Locais (não em `navegacao/icones.tsx`) porque
 * aquele arquivo é a barra de navegação — etiqueta e lixeira só existem
 * neste cartão. Mesmo traço (1.5, `currentColor`) dos ícones de lá.
 */
function IconeEtiqueta(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M2 2h5.5L14 8.5 8.5 14 2 7.5V2Z" />
      <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconeLixeira(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" {...props}>
      <path d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.6 8.5h6.8l.6-8.5M6.5 7v4M9.5 7v4" />
    </svg>
  );
}

function IconeSeta({ direcao, ...props }: SVGProps<SVGSVGElement> & { direcao: "cima" | "baixo" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={direcao === "baixo" ? "rotate-180" : undefined}
      {...props}
    >
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

/**
 * Um livro na grade da estante: capa (real ou sintética, sempre 2:3),
 * título, autor e o progresso de leitura.
 *
 * O que mora em REPOUSO é só isso. Reordenar, categorias e remover ficam
 * numa faixa sobre a base da capa que só aparece no hover, no foco de
 * teclado ou enquanto a lista de categorias está aberta — doze cartões
 * mostrando "Remover" ao mesmo tempo era ruído, e ação destrutiva não
 * fica à vista sem ninguém pedir.
 *
 * A barra lê `progresso.furthestFraction`, nunca `currentFraction`: é o
 * ponto mais distante já lido, que só cresce. Ler `currentFraction` faria a
 * barra andar PARA TRÁS sempre que o usuário volta uma página — o contrário
 * do que uma barra de progresso promete.
 */
export function LivroCard({
  item,
  onAbrir,
  onRemover,
  podeMoverParaCima,
  podeMoverParaBaixo,
  onMoverParaCima,
  onMoverParaBaixo,
}: LivroCardProps) {
  const { livro, progresso, titulo, autor } = item;
  const percentual = Math.round(progresso.furthestFraction * 100);

  const editarTituloDoLivro = useBibliotecaStore((state) => state.editarTituloDoLivro);
  const editarAutorDoLivro = useBibliotecaStore((state) => state.editarAutorDoLivro);
  const [editandoTitulo, setEditandoTitulo] = useState(false);
  const [editandoAutor, setEditandoAutor] = useState(false);
  const [erroTitulo, setErroTitulo] = useState<string | null>(null);
  const [erroAutor, setErroAutor] = useState<string | null>(null);

  function iniciarEdicaoDeTitulo() {
    setErroTitulo(null);
    setEditandoTitulo(true);
  }

  function iniciarEdicaoDeAutor() {
    setErroAutor(null);
    setEditandoAutor(true);
  }

  // `titulo` já é o valor RESOLVIDO que a estante mostra (metadado salvo OU
  // o nome do arquivo, decisão do backend) — comparar contra ele é o que
  // evita um Enter sem mudança nenhuma virar uma chamada ao IPC gravando o
  // título derivado do arquivo como se fosse um metadado de verdade.
  async function confirmarEdicaoDeTitulo(valor: string): Promise<boolean> {
    if (valor === titulo) {
      setEditandoTitulo(false);
      return true;
    }
    try {
      await editarTituloDoLivro(livro.id, valor);
      setEditandoTitulo(false);
      setErroTitulo(null);
      return true;
    } catch (error) {
      // Continua em modo de edição, sem perder o que foi digitado — mesmo
      // padrão de `LinhaDeCategoria.confirmarRenomeio`.
      setErroTitulo(messageFor(error, "Não foi possível editar o título."));
      return false;
    }
  }

  // O valor EDITÁVEL do autor é `autor ?? ""` — nunca o texto de fallback
  // "Autor desconhecido" que a VIEW mostra: aquele texto é rótulo de UI, não
  // um valor que faça sentido gravar como metadado se o usuário confirmar
  // sem mexer em nada.
  async function confirmarEdicaoDeAutor(valor: string): Promise<boolean> {
    if (valor === (autor ?? "")) {
      setEditandoAutor(false);
      return true;
    }
    try {
      await editarAutorDoLivro(livro.id, valor);
      setEditandoAutor(false);
      setErroAutor(null);
      return true;
    } catch (error) {
      setErroAutor(messageFor(error, "Não foi possível editar o autor."));
      return false;
    }
  }

  // Categorias vêm direto da store (não por prop): `PainelDeBiblioteca` já
  // carrega `categorias`/`categoriasPorLivro` uma vez para a seção inteira, e
  // cada cartão só lê o que é dele — evita cada `LivroCard` refazer o mesmo
  // `listarCategoriasDoLivro` que a estante já buscou em bloco (PARTE 2,
  // `listarCategoriasPorLivro`).
  const categorias = useBibliotecaStore((state) => state.categorias);
  const categoriasPorLivro = useBibliotecaStore((state) => state.categoriasPorLivro);
  const atribuirCategorias = useBibliotecaStore((state) => state.atribuirCategorias);
  const categoriasDoLivro = categoriasPorLivro.get(livro.id) ?? [];
  const idsDasCategoriasDoLivro = new Set(categoriasDoLivro.map((categoria) => categoria.id));
  const [atualizandoCategorias, setAtualizandoCategorias] = useState(false);

  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);

  // `livro.coverFileName` é só o NOME do arquivo em `media/` (o que
  // persiste), nunca uma URL exibível — precisa passar por `resolveMediaSrc`
  // antes de ir num `src`, mesmo padrão de `CartaoNode.tsx` (mapa mental) e
  // `FileThumbnail` (propriedade Arquivos). `cancelado` evita que a
  // resolução de uma capa antiga sobrescreva a de uma capa nova gerada
  // depois (`atualizarCapaNaEstante` troca `coverFileName` em memória).
  const [urlDaCapa, setUrlDaCapa] = useState("");
  // Arquivo de capa que existe no registro mas não carrega (apagado da
  // pasta `media/`, corrompido): cai na capa sintética em vez de deixar o
  // ícone de imagem quebrada do navegador — que é o único estado que uma
  // estante nunca deveria mostrar.
  const [capaFalhou, setCapaFalhou] = useState(false);
  useEffect(() => {
    setCapaFalhou(false);
    if (!livro.coverFileName) {
      setUrlDaCapa("");
      return;
    }
    let cancelado = false;
    void resolveMediaSrc(livro.coverFileName).then((url) => {
      if (!cancelado) setUrlDaCapa(url);
    });
    return () => {
      cancelado = true;
    };
  }, [livro.coverFileName]);

  // Convenção do projeto (ver `PainelDeMaterias.tsx`, `LinhaDeMateria`):
  // confirmação inline neste próprio cartão, NUNCA `window.confirm` — o
  // diálogo nativo trava a WebView do Tauri.
  async function alternarCategoria(categoriaId: string) {
    if (atualizandoCategorias) return;
    const proximosIds = idsDasCategoriasDoLivro.has(categoriaId)
      ? [...idsDasCategoriasDoLivro].filter((id) => id !== categoriaId)
      : [...idsDasCategoriasDoLivro, categoriaId];
    setAtualizandoCategorias(true);
    try {
      await atribuirCategorias(livro.id, proximosIds);
    } catch {
      // Erro já fica em `errorMessage` da store; o checkbox volta ao estado
      // anterior sozinho porque `categoriasPorLivro` só muda em caso de
      // sucesso — nada a reverter aqui.
    } finally {
      setAtualizandoCategorias(false);
    }
  }

  const temCapaReal = Boolean(livro.coverFileName) && !capaFalhou;

  const classeDoBotaoDaFaixa =
    "grid h-full min-w-9 flex-1 place-items-center text-ink-muted transition-colors " +
    "hover:bg-surface-raised hover:text-ink focus-visible:-outline-offset-2 " +
    "disabled:pointer-events-none disabled:opacity-30 [&>svg]:size-4";

  return (
    <div data-slot="livro-card" className="group flex flex-col gap-2">
      {/* A moldura é o que sobe no hover (`biblioteca.css`): capa, faixa de
          ações e confirmação de remover moram todos dentro dela, então
          levantam juntos. `overflow-hidden` recorta a capa no raio e
          mantém o painel de categorias dentro dos limites da capa. */}
      {/* `grid` com capa e faixa na MESMA célula (não faixa `absolute`): a
          faixa fica estática, então o painel de categorias, que é
          `absolute`, se posiciona contra a moldura — a capa inteira — e não
          contra os 44px da faixa. */}
      <div
        data-slot="capa-moldura"
        className="relative grid overflow-hidden rounded-sm border border-hairline bg-surface-sunken shadow-hard-sm"
      >
        {/* Só a CAPA abre a leitura por clique direto — título e autor
            precisam ficar FORA deste botão (não dá para aninhar um `<input>`
            de edição dentro de um `<button>`, HTML inválido e ilegível para
            leitor de tela). Clicar no TÍTULO ainda abre a leitura (o botão
            próprio dele logo abaixo chama o mesmo `onAbrir`) — só editar é
            que precisou de um caminho separado (duplo clique ou o lápis). */}
        <button
          type="button"
          onClick={onAbrir}
          aria-label={`Abrir ${titulo}`}
          data-slot="capa"
          className="col-start-1 row-start-1 block w-full text-left focus-visible:-outline-offset-2"
        >
          {temCapaReal ? (
            urlDaCapa ? (
              // `alt` é o título do livro, não "capa": é isto que dá sentido à
              // imagem para quem usa leitor de tela, do mesmo jeito que o nome
              // do livro já dá sentido ao card inteiro.
              //
              // `draggable={false}`: o navegador arrasta imagem por conta própria,
              // e esse arraste nativo ROUBA o gesto do `<li draggable>` da grade —
              // o cursor vira o sinal de proibido e o livro não reordena. Desligar
              // aqui faz o gesto pertencer sempre ao cartão.
              <img
                src={urlDaCapa}
                alt={titulo}
                draggable={false}
                onError={() => setCapaFalhou(true)}
                className="aspect-[2/3] w-full object-cover"
              />
            ) : (
              // Capa existe mas a URL ainda está sendo resolvida: um
              // retângulo quieto do tamanho certo, não a capa sintética —
              // senão a estante piscaria de "capa colorida" para "capa
              // real" a cada montagem.
              <span aria-hidden="true" className="block aspect-[2/3] w-full" />
            )
          ) : (
            // Sem capa (livro sem `coverFileName`, ou a extração falhou/ainda
            // não rodou): uma capa SINTÉTICA — título e autor sobre uma cor
            // derivada do título, na mesma proporção 2:3 da capa real.
            //
            // Título e autor entram por `data-*` e viram texto em
            // `::before`/`::after` (`biblioteca.css`), NÃO como nós de texto:
            // o título já é o nome acessível do botão e o texto do cartão
            // logo abaixo — repeti-lo no DOM faria o leitor de tela (e
            // qualquer `getByText`) encontrar o mesmo título duas vezes por
            // livro. Aqui ele é desenho, e desenho não entra na árvore.
            <span
              aria-hidden="true"
              data-slot="capa-sintetica"
              data-cor={corDaCapaSintetica(titulo)}
              data-titulo={titulo}
              data-autor={autor ?? ""}
              className="relative flex aspect-[2/3] w-full flex-col p-3 pl-4 pb-9"
            >
              <span className="absolute bottom-3 right-3 text-xs font-medium uppercase tracking-wider text-ink opacity-70">
                {livro.format}
              </span>
            </span>
          )}
        </button>

        {confirmandoRemocao ? (
          // Confirmação SOBRE a capa: o cartão não muda de tamanho, a grade
          // não se mexe, e a pergunta fica exatamente onde o gesto começou.
          <div
            role="alertdialog"
            aria-label={`Remover ${titulo}?`}
            className="absolute inset-0 flex flex-col justify-end gap-3 bg-surface p-3"
          >
            <p className="text-xs leading-snug text-ink">
              Remover da biblioteca? O arquivo importado é apagado.
            </p>
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setConfirmandoRemocao(false);
                  onRemover();
                }}
                className="min-h-9 rounded-sm border border-terracotta-ink px-2 text-xs font-medium text-terracotta-ink
                  transition-colors hover:bg-surface-raised active:scale-97"
              >
                Remover mesmo assim
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmandoRemocao(false)}
                className="min-h-9 rounded-sm border border-border px-2 text-xs text-ink transition-colors hover:bg-surface-raised active:scale-97"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          // Faixa de ações sobre a base da capa. Altura = `--hit-min`: os
          // botões desenham pequenos, mas a área que reage é a do dedo.
          //
          // "Mover para cima/baixo" é o caminho de TECLADO de reordenar —
          // regra dura de acessibilidade, arrastar com o mouse
          // (`GradeDeLivros`) não pode ser o único jeito. A faixa aparece
          // por `:focus-within` do cartão (`biblioteca.css`), então o botão
          // já está visível no instante em que o Tab chega nele — nunca um
          // alvo focado invisível.
          <div
            data-slot="acoes-da-capa"
            // Sem `backdrop-blur`: `backdrop-filter` vira bloco de contenção
            // para descendentes `absolute`, e o painel de categorias
            // passaria a nascer dentro destes 44px em vez de encher a capa.
            className="col-start-1 row-start-1 z-10 flex h-(--hit-min) items-stretch self-end border-t border-hairline bg-surface/92"
          >
            <button
              type="button"
              onClick={onMoverParaCima}
              disabled={!podeMoverParaCima}
              aria-label={`Mover ${titulo} para cima`}
              title="Mover para cima"
              className={classeDoBotaoDaFaixa}
            >
              <IconeSeta direcao="cima" />
            </button>
            <button
              type="button"
              onClick={onMoverParaBaixo}
              disabled={!podeMoverParaBaixo}
              aria-label={`Mover ${titulo} para baixo`}
              title="Mover para baixo"
              className={classeDoBotaoDaFaixa}
            >
              <IconeSeta direcao="baixo" />
            </button>

            {/* `<details>` nativo: abre/fecha sem estado React e sem ARIA à
                mão. O conteúdo é posicionado contra a MOLDURA (não contra o
                `<details>`, que não é `relative`): preenche a capa acima da
                faixa, rola se a lista for longa, e nunca sai do cartão. */}
            <details className="flex flex-1">
              <summary
                aria-label={`Categorias de ${titulo}${categoriasDoLivro.length > 0 ? ` (${categoriasDoLivro.length})` : ""}`}
                title="Categorias"
                className={`${classeDoBotaoDaFaixa} relative cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
              >
                <IconeEtiqueta />
                {categoriasDoLivro.length > 0 ? (
                  <span className="absolute right-1.5 top-1.5 min-w-4 rounded-full bg-emerald px-1 text-center text-xs leading-4 font-medium text-on-emerald">
                    {categoriasDoLivro.length}
                  </span>
                ) : null}
              </summary>
              <div className="absolute inset-x-0 top-0 bottom-(--hit-min) z-10 overflow-y-auto bg-surface p-3">
                <p className="mb-1.5 text-xs font-medium text-ink">Categorias</p>
                {categorias.length === 0 ? (
                  <p className="text-xs text-ink-muted">Nenhuma categoria criada ainda.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {categorias.map((categoria) => (
                      <li key={categoria.id}>
                        <label className="flex min-h-6 items-center gap-1.5 text-xs text-ink">
                          <input
                            type="checkbox"
                            checked={idsDasCategoriasDoLivro.has(categoria.id)}
                            disabled={atualizandoCategorias}
                            onChange={() => void alternarCategoria(categoria.id)}
                          />
                          {categoria.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>

            <button
              type="button"
              onClick={() => setConfirmandoRemocao(true)}
              aria-label={`Remover ${titulo}`}
              title="Remover da biblioteca"
              className={`${classeDoBotaoDaFaixa} hover:text-terracotta-ink`}
            >
              <IconeLixeira />
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        {editandoTitulo ? (
          <div className="flex flex-col gap-0.5">
            <CampoDeTextoInline
              rotulo={`Título de ${titulo}`}
              valorInicial={titulo}
              onConfirmar={confirmarEdicaoDeTitulo}
              onCancelar={() => setEditandoTitulo(false)}
            />
            {erroTitulo ? (
              <p role="alert" className="text-xs text-terracotta-ink">
                {erroTitulo}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-10 items-start gap-1">
            {/* Serifada (`font-display`), duas linhas: é o lado "livro" da
                marca, e "Grande Sertão: Veredas" cabe inteiro em vez de
                virar "Grande Sertão: Ver…". `min-h-10` RESERVA as duas
                linhas mesmo num título curto — assim autor e progresso
                ficam na mesma altura em todos os cartões da fila. */}
            <button
              type="button"
              onClick={onAbrir}
              onDoubleClick={iniciarEdicaoDeTitulo}
              className="min-w-0 flex-1 text-left font-display text-sm leading-snug text-ink line-clamp-2"
              title={titulo}
            >
              {titulo}
            </button>
            <button
              type="button"
              onClick={iniciarEdicaoDeTitulo}
              aria-label={`Editar título de ${titulo}`}
              className="shrink-0 rounded-sm px-1 text-xs text-ink-muted opacity-0 transition-opacity
                hover:bg-surface-raised hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100"
            >
              ✎
            </button>
          </div>
        )}

        {editandoAutor ? (
          <div className="flex flex-col gap-0.5">
            <CampoDeTextoInline
              rotulo={`Autor de ${titulo}`}
              placeholder="Autor desconhecido"
              valorInicial={autor ?? ""}
              onConfirmar={confirmarEdicaoDeAutor}
              onCancelar={() => setEditandoAutor(false)}
            />
            {erroAutor ? (
              <p role="alert" className="text-xs text-terracotta-ink">
                {erroAutor}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {/* Diferente do título, o autor não compete com nenhuma outra
                ação neste elemento (não abre o livro) — um clique já basta
                para editar, sem precisar do acelerador de duplo clique. */}
            <button
              type="button"
              onClick={iniciarEdicaoDeAutor}
              className="min-w-0 flex-1 truncate text-left text-xs text-ink-muted"
              title={autor ?? undefined}
            >
              {autor ?? "Autor desconhecido"}
            </button>
            <button
              type="button"
              onClick={iniciarEdicaoDeAutor}
              aria-label={`Editar autor de ${titulo}`}
              className="shrink-0 rounded-sm px-1 text-xs text-ink-muted opacity-0 transition-opacity
                hover:bg-surface-raised hover:text-ink group-hover:opacity-100 group-focus-within:opacity-100"
            >
              ✎
            </button>
          </div>
        )}

        {/* Progresso: UMA pista por estado, não duas. Lendo = barra +
            porcentagem (a barra dá a proporção de relance, o número dá a
            precisão que uma barra de 170px não tem). Lido = a palavra, com
            a marca — "100%" ao lado seria dizer a mesma coisa duas vezes.
            Não lido = nada: ausência de progresso É a informação, e doze
            "Não lido" na tela seriam ruído. A linha tem altura fixa para
            os três estados alinharem entre cartões vizinhos. */}
        <div className="mt-1 flex h-4 items-center gap-2">
          {progresso.status === "reading" ? (
            <>
              {/* `<progress>` nativo, não uma div com `role="progressbar"`: é
                  elemento antes de ARIA (regra do projeto). Pintado em
                  `biblioteca.css`, só com token. */}
              <progress
                aria-label={`Progresso de leitura de ${titulo}`}
                value={percentual}
                max={100}
                data-slot="progresso-de-leitura"
                className="w-full min-w-0 flex-1"
              />
              <span className="shrink-0 text-xs tabular-nums text-ink-muted">{percentual}%</span>
            </>
          ) : null}
          {progresso.status === "finished" ? (
            <span className="text-xs font-medium text-mint-ink">
              <span aria-hidden="true">✓ </span>Lido
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
