import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AppError, type Categoria, type LivroNaEstante } from "../../lib/ipc";
import { hidePopoverSafely } from "../pages/dom-compat";
import { useOpenTransition } from "../pages/use-open-transition";
import { usePosicaoAncorada } from "../pages/use-posicao-ancorada";
import {
  buildCategoriaChildrenIndex,
  categoriaMoveTargets,
  contarPorStatus,
  filtrarLivros,
  flattenVisibleCategoriaTree,
  getCategoriaDescendantIds,
  type CategoriaFlatNode,
} from "./filtro";
import { ImportarLivroButton } from "./ImportarLivroButton";
import { useBibliotecaStore, type FiltroDeStatus } from "./store";

const FILTROS: { id: FiltroDeStatus; rotulo: string }[] = [
  { id: "todos", rotulo: "Todos os livros" },
  { id: "unread", rotulo: "Não lido" },
  { id: "reading", rotulo: "Lendo" },
  { id: "finished", rotulo: "Lido" },
];

/**
 * Toda linha selecionável deste painel (filtro de status, "Todas as
 * categorias", categoria) segue DESIGN-TOKENS §8: ativa = fundo `raised` +
 * acento âmbar na borda esquerda; hover = só o fundo. O painel inteiro já
 * está sobre `surface-sunken` (barra lateral), então `sunken` como cor de
 * "ativo" era invisível — mesma cor sobre a mesma cor. Os 2px da borda ficam
 * reservados em repouso (`border-transparent`) para nada deslocar ao
 * selecionar.
 */
const LINHA_ATIVA = "border-amber bg-surface-raised text-ink";
const LINHA_EM_REPOUSO = "border-transparent text-ink hover:bg-surface-raised";

/** Botões de ação da linha (`+`, `⋯`): o mesmo desenho de `PageTreeItem` e `PageContextMenu`. */
const BOTAO_DE_ACAO =
  "grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted transition-transform hover:bg-surface hover:text-ink active:scale-97";

const CAMPO_INLINE = "min-w-0 flex-1 rounded-sm border border-border bg-paper px-1 py-0.5 text-sm text-ink";

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

function formatarContagemDeLivros(quantidade: number): string {
  return quantidade === 1 ? "1 livro" : `${quantidade} livros`;
}

/**
 * Quantos livros aparecem na estante ao filtrar por cada categoria — a mesma
 * semântica D1 de `filtrarPorCategoria` (`filtro.ts`): o pai conta os livros
 * dos descendentes, e um livro em duas categorias da mesma subárvore conta
 * uma vez só. Percorre os ancestrais de cada categoria de cada livro em vez
 * de filtrar a estante uma vez por categoria: N livros × profundidade, não
 * N × categorias. Só livros que ESTÃO na estante contam — `categoriasPorLivro`
 * pode guardar um livro já removido nesta sessão.
 */
function contarLivrosPorCategoria(
  categorias: readonly Categoria[],
  categoriasPorLivro: ReadonlyMap<string, Categoria[]>,
  livros: readonly LivroNaEstante[],
): Map<string, number> {
  const parentById = new Map(categorias.map((categoria) => [categoria.id, categoria.parentId]));
  const naEstante = new Set(livros.map((item) => item.livro.id));
  const livrosPorCategoria = new Map<string, Set<string>>();
  for (const [livroId, categoriasDoLivro] of categoriasPorLivro) {
    if (!naEstante.has(livroId)) continue;
    for (const categoria of categoriasDoLivro) {
      // `visitados` guarda contra um ciclo que o backend não deveria deixar
      // existir — um loop infinito aqui travaria o painel inteiro.
      const visitados = new Set<string>();
      let atual: string | null = categoria.id;
      while (atual !== null && !visitados.has(atual)) {
        visitados.add(atual);
        let conjunto = livrosPorCategoria.get(atual);
        if (!conjunto) {
          conjunto = new Set();
          livrosPorCategoria.set(atual, conjunto);
        }
        conjunto.add(livroId);
        atual = parentById.get(atual) ?? null;
      }
    }
  }
  return new Map([...livrosPorCategoria].map(([id, conjunto]) => [id, conjunto.size]));
}

/** Ids dos ancestrais de `id` (pai, avô, …), sem o próprio `id`. */
function ancestraisDe(id: string, parentById: ReadonlyMap<string, string | null>): string[] {
  const ancestrais: string[] = [];
  let atual = parentById.get(id) ?? null;
  while (atual !== null && !ancestrais.includes(atual)) {
    ancestrais.push(atual);
    atual = parentById.get(atual) ?? null;
  }
  return ancestrais;
}

/**
 * Um `<span>` por nível de profundidade, cada um com uma linha vertical à
 * esquerda: substitui o recuo cego de `paddingLeft` por um recuo QUE DESENHA
 * — uma guia contínua descendo do pai por todos os filhos. Só funciona
 * porque a lista não tem gap entre linhas (a guia precisa encostar de linha
 * em linha). `hairline` é o divisor decorativo (abaixo de 3:1 de propósito);
 * `aria-hidden` porque a estrutura para leitor de tela vem de `aria-expanded`
 * e da contagem lida no nome.
 */
function GuiasDeNivel({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, nivel) => (
        <span key={nivel} aria-hidden="true" data-slot="guia-de-nivel" className="w-4 shrink-0 self-stretch border-l border-hairline" />
      ))}
    </>
  );
}

interface CampoDeNomeInlineProps {
  rotulo: string;
  placeholder?: string;
  valorInicial: string;
  /**
   * Recebe o nome já sem espaços nas pontas e diz se o campo FECHOU
   * (`true`) ou continua aberto com o que foi digitado (`false` — o dono
   * mostrou o erro do backend, D3). `viaTeclado` distingue Enter de blur:
   * só o Enter devolve o foco ao nome, um clique fora não rouba o foco de
   * onde o usuário clicou.
   */
  onConfirmar: (nome: string, viaTeclado: boolean) => Promise<boolean>;
  onCancelar: () => void;
}

/**
 * Campo de nome que mora NA linha (renomear, nova subcategoria, nova
 * categoria na raiz): Enter confirma, Escape cancela, blur confirma — sem
 * "Salvar/Cancelar" em texto, como `PageTreeItem`. A única borda de controle
 * (`border-border bg-paper`) do painel aparece aqui, e só enquanto se digita.
 */
function CampoDeNomeInline({ rotulo, placeholder, valorInicial, onConfirmar, onCancelar }: CampoDeNomeInlineProps) {
  const [valor, setValor] = useState(valorInicial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Depois que o campo fechou (confirmou ou cancelou), um blur atrasado do
  // desmonte não pode confirmar de novo; e enquanto uma confirmação está em
  // voo, Enter repetido não dispara uma segunda.
  const fechadoRef = useRef(false);
  const emVooRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function confirmar(viaTeclado: boolean) {
    if (fechadoRef.current || emVooRef.current) return;
    emVooRef.current = true;
    try {
      const fechou = await onConfirmar(valor.trim(), viaTeclado);
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
      onBlur={() => void confirmar(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void confirmar(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelar();
        }
      }}
      aria-label={rotulo}
      placeholder={placeholder}
      className={CAMPO_INLINE}
    />
  );
}

interface MenuDeCategoriaProps {
  nome: string;
  onRenomear: () => void;
  onNovaSubcategoria: () => void;
  onMover: () => void;
  onRemover: () => void;
}

/**
 * O "⋯" da linha — `PageContextMenu` replicado: `popover="auto"` fecha ao
 * clicar fora e com Escape (devolvendo o foco ao gatilho) sem listener
 * escrito à mão; `usePosicaoAncorada` prende o painel ao botão. O destrutivo
 * fica isolado no fim, em terracota. "Nova subcategoria" repete o "+" da
 * linha de propósito: o "+" é o atalho de mouse, o item de menu é o caminho
 * completo por teclado — nenhuma ação depende de hover.
 */
function MenuDeCategoria({ nome, onRenomear, onNovaSubcategoria, onMover, onRemover }: MenuDeCategoriaProps) {
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const gatilhoRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const entered = useOpenTransition(open);
  usePosicaoAncorada(gatilhoRef, panelRef, open, { alinhamento: "fim" });

  function escolher(acao: () => void) {
    acao();
    hidePopoverSafely(panelRef.current);
  }

  return (
    <span className="relative inline-flex">
      <button
        ref={gatilhoRef}
        type="button"
        popoverTarget={panelId}
        popoverTargetAction="toggle"
        aria-label={`Mais ações para ${nome}`}
        className={BOTAO_DE_ACAO}
      >
        ⋯
      </button>

      <div
        id={panelId}
        ref={panelRef}
        popover="auto"
        role="menu"
        aria-label={`Ações para ${nome}`}
        onToggle={(event) => setOpen(event.newState === "open")}
        className={`w-48 origin-top-right rounded-md border border-border
          bg-surface p-1 shadow-hard transition duration-150 ease-out motion-reduce:transition-none
          ${entered ? "scale-100 opacity-100" : "scale-95 opacity-0"}`}
      >
        <ItemDeMenu onSelect={() => escolher(onRenomear)}>Renomear</ItemDeMenu>
        <ItemDeMenu onSelect={() => escolher(onNovaSubcategoria)}>Nova subcategoria</ItemDeMenu>
        <ItemDeMenu onSelect={() => escolher(onMover)}>Mover para…</ItemDeMenu>
        <ItemDeMenu destrutivo onSelect={() => escolher(onRemover)}>
          Remover…
        </ItemDeMenu>
      </div>
    </span>
  );
}

/** Item do menu: sem `active:scale-97` de propósito — some junto com o menu no clique, não há o que ver encolher. */
function ItemDeMenu({ children, onSelect, destrutivo }: { children: string; onSelect: () => void; destrutivo?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-sunken
        ${destrutivo ? "text-terracotta-ink" : "text-ink"}`}
    >
      {children}
    </button>
  );
}

interface DialogoDeMoverCategoriaProps {
  /** `null` = fechado. */
  categoria: Categoria | null;
  /** Alvos válidos — já sem a própria categoria nem os descendentes dela (`categoriaMoveTargets`). */
  alvos: CategoriaFlatNode[];
  onMover: (novoParentId: string | null) => Promise<void>;
  onFechar: () => void;
}

/**
 * "Mover para…" em `<dialog>` modal, cópia estrutural de `MoveToDialog`
 * (Notas): foco preso, Escape e clique no fundo fecham. A lista mostra a
 * árvore inteira com as MESMAS guias da barra lateral — nunca travessões
 * fingindo hierarquia. Sem campo de busca por enquanto: categorias chegam a
 * dezenas, não centenas; o esqueleto de `MoveToDialog` mostra onde ele entra
 * se um dia passar de ~25 alvos.
 */
function DialogoDeMoverCategoria({ categoria, alvos, onMover, onFechar }: DialogoDeMoverCategoriaProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // `showModal`/`close` existem no WebView2, não no jsdom (ver `dom-compat.ts`).
    if (categoria) {
      if (typeof dialog.showModal === "function") dialog.showModal();
    } else if (typeof dialog.close === "function") {
      dialog.close();
    }
  }, [categoria]);

  const opcao = "flex w-full items-center rounded-sm px-2 py-1 text-left text-sm text-ink hover:bg-surface-sunken";

  return (
    <dialog
      ref={dialogRef}
      onClose={onFechar}
      onCancel={onFechar}
      onClick={(event) => {
        if (event.target === event.currentTarget) onFechar();
      }}
      className="w-full max-w-sm rounded-md border border-border bg-surface p-0 text-ink shadow-hard backdrop:bg-ink/40"
    >
      {categoria ? (
        <div className="p-4">
          <h2 className="font-display text-lg text-ink">Mover &ldquo;{categoria.name}&rdquo; para</h2>

          <ul className="mt-3 max-h-64 overflow-y-auto" role="listbox" aria-label="Categorias de destino">
            <li>
              <button type="button" role="option" aria-selected={false} onClick={() => void onMover(null)} className={opcao}>
                Raiz (sem categoria-pai)
              </button>
            </li>
            {alvos.map((alvo) => (
              <li key={alvo.categoria.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => void onMover(alvo.categoria.id)}
                  className={opcao}
                >
                  <GuiasDeNivel depth={alvo.depth} />
                  <span className="min-w-0 flex-1 truncate">{alvo.categoria.name}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex justify-end">
            <button type="button" onClick={onFechar} className="rounded-sm border border-border px-3 py-1.5 text-sm text-ink">
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

interface LinhaDeCategoriaProps {
  categoria: Categoria;
  /** Nível na árvore — 0 é raiz. Vira uma guia vertical por nível (`GuiasDeNivel`), 16px cada como em `PageTreeItem`. */
  depth: number;
  temFilhos: boolean;
  recolhida: boolean;
  /** Quantos livros a estante mostra ao filtrar por esta categoria (D1: inclui descendentes). */
  contagem: number;
  onAlternarRecolhimento: () => void;
  /** Garante a linha expandida — uma subcategoria nova precisa nascer visível. */
  onExpandir: () => void;
  selecionada: boolean;
  /** Recolhida E o filtro atual está num descendente: a barra âmbar diz "o filtro está aqui dentro". */
  contemFiltro: boolean;
  onSelecionar: () => void;
  onRenomear: (nome: string) => Promise<void>;
  onRemover: () => Promise<void>;
  /** D2: cria uma categoria FILHA desta linha (parentId = `categoria.id`). */
  onCriarFilha: (nome: string) => Promise<void>;
  /** Abre o diálogo de mover; `definirErro` é por onde uma recusa do backend volta para esta linha. */
  onSolicitarMover: (definirErro: (mensagem: string | null) => void) => void;
}

/**
 * Uma categoria da árvore. Em repouso mostra só o que se LÊ: guias de nível,
 * chevron (só quem tem filhos), nome (raiz em `font-semibold`) e contagem de
 * livros. Tudo o que se FAZ aparece sob a mão do usuário, pelo mesmo caminho
 * de `PageTreeItem`/`DeckTreeRow`: hover ou foco trocam a contagem por "+" e
 * "⋯" no mesmo slot de 48px (opacidade, sem mexer no layout); o menu leva a
 * renomear, nova subcategoria, mover e remover. Duplo clique no nome e F2 são
 * os aceleradores de renomear das outras duas árvores — selecionar duas vezes
 * o mesmo filtro é idempotente, então o duplo clique não briga com o clique.
 * Confirmação de remoção fica NESTE painel (nunca `window.confirm`, que trava
 * a WebView), mesmo padrão de `LinhaDeMateria` em `PainelDeMaterias`.
 */
function LinhaDeCategoria({
  categoria,
  depth,
  temFilhos,
  recolhida,
  contagem,
  onAlternarRecolhimento,
  onExpandir,
  selecionada,
  contemFiltro,
  onSelecionar,
  onRenomear,
  onRemover,
  onCriarFilha,
  onSolicitarMover,
}: LinhaDeCategoriaProps) {
  const [renomeando, setRenomeando] = useState(false);
  const [criandoFilha, setCriandoFilha] = useState(false);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const nomeRef = useRef<HTMLButtonElement>(null);
  // Ação encerrada pelo TECLADO (Enter/Escape no campo, Escape/Cancelar no
  // cartão) devolve o foco ao nome; encerrada por clique fora, não — o foco
  // fica onde o usuário clicou.
  const devolverFocoRef = useRef(false);

  useEffect(() => {
    if (renomeando || criandoFilha || confirmandoRemocao || !devolverFocoRef.current) return;
    devolverFocoRef.current = false;
    nomeRef.current?.focus();
  }, [renomeando, criandoFilha, confirmandoRemocao]);

  function iniciarRenomeio() {
    setErro(null);
    setCriandoFilha(false);
    setConfirmandoRemocao(false);
    setRenomeando(true);
  }

  async function confirmarRenomeio(nome: string, viaTeclado: boolean): Promise<boolean> {
    // Nome vazio nunca chega ao IPC; nome igual ao atual não é mudança de
    // verdade — mesma guarda de `LinhaDeMateria.confirmarRenomeio`.
    if (nome === "" || nome === categoria.name) {
      devolverFocoRef.current = viaTeclado;
      setRenomeando(false);
      return true;
    }
    try {
      await onRenomear(nome);
      devolverFocoRef.current = viaTeclado;
      setRenomeando(false);
      setErro(null);
      return true;
    } catch (error) {
      // Continua em modo de edição: o backend recusou (nome já usado entre
      // IRMÃOS, ignorando caixa/acento — D3) e a mensagem dele NOMEIA a
      // categoria conflitante — mostrar essa mensagem, sem o usuário perder
      // o que digitou.
      setErro(messageFor(error, "Não foi possível renomear a categoria."));
      return false;
    }
  }

  function iniciarCriacaoDeFilha() {
    setErro(null);
    setRenomeando(false);
    setConfirmandoRemocao(false);
    // A filha nasce visualmente dentro do pai — um pai recolhido expande antes.
    onExpandir();
    setCriandoFilha(true);
  }

  async function confirmarCriacaoDeFilha(nome: string, viaTeclado: boolean): Promise<boolean> {
    if (nome === "") {
      devolverFocoRef.current = viaTeclado;
      setCriandoFilha(false);
      return true;
    }
    try {
      await onCriarFilha(nome);
      devolverFocoRef.current = viaTeclado;
      setCriandoFilha(false);
      setErro(null);
      return true;
    } catch (error) {
      // Mesmo motivo de `confirmarRenomeio`: nome duplicado entre irmãos (D3)
      // é recusado pelo backend com uma mensagem que nomeia o conflito.
      setErro(messageFor(error, "Não foi possível criar a subcategoria."));
      return false;
    }
  }

  function pedirConfirmacaoDeRemocao() {
    setErro(null);
    setRenomeando(false);
    setCriandoFilha(false);
    setConfirmandoRemocao(true);
  }

  function cancelarRemocao() {
    devolverFocoRef.current = true;
    setConfirmandoRemocao(false);
  }

  async function confirmarRemocao() {
    setConfirmandoRemocao(false);
    try {
      await onRemover();
    } catch (error) {
      // D4: se `categoria` ainda tem filhas, o backend recusa (mensagem já
      // nomeia a contagem) — a mesma mensagem chega aqui, mesmo já tendo
      // avisado no cartão de confirmação: o aviso é preventivo, o backend
      // continua sendo quem decide de verdade.
      setErro(messageFor(error, "Não foi possível remover a categoria."));
    }
  }

  function aoTeclarNoNome(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "F2") {
      event.preventDefault();
      iniciarRenomeio();
    }
  }

  const estadoDaLinha = selecionada
    ? LINHA_ATIVA
    : contemFiltro
      ? "border-amber text-ink hover:bg-surface-raised"
      : LINHA_EM_REPOUSO;

  return (
    <li className={depth === 0 ? "mt-2" : ""}>
      <div className={`group relative flex items-center rounded-sm border-l-2 py-0.5 pr-1 ${estadoDaLinha}`}>
        <GuiasDeNivel depth={depth} />
        <button
          type="button"
          onClick={onAlternarRecolhimento}
          aria-label={temFilhos ? (recolhida ? `Expandir ${categoria.name}` : `Recolher ${categoria.name}`) : undefined}
          aria-expanded={temFilhos ? !recolhida : undefined}
          tabIndex={temFilhos ? 0 : -1}
          className={`grid size-5 shrink-0 place-items-center rounded-sm text-ink-muted transition-transform duration-150 ease-out
            ${recolhida ? "" : "rotate-90"} ${temFilhos ? "" : "invisible"}`}
        >
          ▶
        </button>

        {renomeando ? (
          <CampoDeNomeInline
            rotulo={`Nome da categoria ${categoria.name}`}
            valorInicial={categoria.name}
            onConfirmar={confirmarRenomeio}
            onCancelar={() => {
              devolverFocoRef.current = true;
              setRenomeando(false);
            }}
          />
        ) : (
          <button
            ref={nomeRef}
            type="button"
            onClick={onSelecionar}
            onDoubleClick={iniciarRenomeio}
            onKeyDown={aoTeclarNoNome}
            aria-current={selecionada ? "true" : undefined}
            className={`min-w-0 flex-1 truncate rounded-sm px-1 py-0.5 text-left text-sm transition-transform active:scale-97
              ${depth === 0 ? "font-semibold" : ""}`}
          >
            {categoria.name}
            <span className="sr-only">
              , {formatarContagemDeLivros(contagem)}
              {contemFiltro ? " — contém o filtro atual" : ""}
            </span>
          </button>
        )}

        {/* Slot fixo de 48px: contagem e ações moram sobrepostas e se alternam por opacidade — nada muda de lugar ao passar o mouse. */}
        <span className="relative h-6 w-12 shrink-0">
          <span
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-end pr-1 text-xs tabular-nums text-ink-muted transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
          >
            {contagem}
          </span>
          <span className="absolute inset-0 flex items-center justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              tabIndex={-1}
              onClick={iniciarCriacaoDeFilha}
              aria-label={`Nova categoria dentro de ${categoria.name}`}
              className={BOTAO_DE_ACAO}
            >
              +
            </button>
            <MenuDeCategoria
              nome={categoria.name}
              onRenomear={iniciarRenomeio}
              onNovaSubcategoria={iniciarCriacaoDeFilha}
              onMover={() => onSolicitarMover(setErro)}
              onRemover={pedirConfirmacaoDeRemocao}
            />
          </span>
        </span>
      </div>

      {criandoFilha ? (
        <div className="flex items-center border-l-2 border-transparent py-0.5 pr-1">
          <GuiasDeNivel depth={depth + 1} />
          <span aria-hidden="true" className="size-5 shrink-0" />
          <CampoDeNomeInline
            rotulo={`Nome da nova categoria dentro de ${categoria.name}`}
            placeholder="Nova subcategoria"
            valorInicial=""
            onConfirmar={confirmarCriacaoDeFilha}
            onCancelar={() => {
              devolverFocoRef.current = true;
              setCriandoFilha(false);
            }}
          />
        </div>
      ) : null}

      {confirmandoRemocao ? (
        <div className="flex border-l-2 border-transparent pr-1">
          <GuiasDeNivel depth={depth} />
          <div
            role="alertdialog"
            aria-label={`Remover ${categoria.name}?`}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelarRemocao();
              }
            }}
            className="my-1 ml-1 flex min-w-0 flex-1 flex-col gap-2 rounded-sm border border-hairline bg-surface p-2"
          >
            {temFilhos ? (
              // D4: o backend RECUSA remover uma categoria com subcategorias
              // (nenhuma promoção automática, nenhum filho fica órfão em
              // silêncio) — avisar isso ANTES de confirmar, não só deixar o
              // erro do backend aparecer depois do clique.
              <p className="text-xs text-ink-muted">
                "{categoria.name}" tem subcategorias. Mova ou remova as subcategorias primeiro — o backend não deixa
                apagar uma categoria com filhas, para nenhuma ficar sem pai. Nenhum livro é apagado.
              </p>
            ) : (
              // "Remover" ao lado de uma lista de livros dá medo, e aqui o medo é
              // infundado: só a ligação some (CASCADE no backend), o livro fica.
              <p className="text-xs text-ink-muted">
                Remover "{categoria.name}"? Os livros dela não são apagados — só perdem essa categoria.
              </p>
            )}
            <div className="flex justify-end gap-2">
              {/* Foco entra em "Cancelar": a pergunta é séria, e Enter por reflexo não pode remover. */}
              <button type="button" autoFocus onClick={cancelarRemocao} className="text-xs text-ink-muted hover:text-ink">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmarRemocao()}
                className="rounded-sm border border-terracotta-ink px-2 py-1 text-xs font-medium text-terracotta-ink hover:bg-surface-raised"
              >
                Remover mesmo assim
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {erro ? (
        <div className="flex border-l-2 border-transparent pr-1">
          <GuiasDeNivel depth={depth} />
          <p role="alert" className="ml-6 py-0.5 text-xs text-terracotta-ink">
            {erro}
          </p>
        </div>
      ) : null}
    </li>
  );
}

/**
 * A lista de categorias como filtro — "Todas as categorias" ao lado dos
 * quatro filtros de status é decisão desta tela: os dois eixos (status,
 * categoria) são independentes e se compõem por "E" (ver
 * `filtrarPorCategoria` em `filtro.ts`), então cada um tem sua própria lista
 * de opções em vez de um produto cartesiano dos dois.
 *
 * Criar na raiz é a linha-fantasma "+ Nova categoria" no fim da lista (cópia
 * de "+ Nova página" em `PageTree`): a única ação que não se esconde, porque
 * um painel vazio precisa anunciá-la — mas em peso mínimo, sem botão primário.
 * O erro de criar fica LOCAL a esse campo (não `errorMessage` da store): nome
 * duplicado é um erro de digitação, não uma falha da estante — mesma
 * separação que `PainelDeMaterias` já faz. Erro de renomear/mover/remover
 * fica local a CADA `LinhaDeCategoria`, pelo mesmo motivo.
 */
function SecaoDeCategorias() {
  const categorias = useBibliotecaStore((state) => state.categorias);
  const categoriasPorLivro = useBibliotecaStore((state) => state.categoriasPorLivro);
  const livros = useBibliotecaStore((state) => state.livros);
  /** O filtro de STATUS, lido aqui só para a contagem por categoria bater com o que a estante mostra. */
  const filtro = useBibliotecaStore((state) => state.filtro);
  const filtroCategoriaId = useBibliotecaStore((state) => state.filtroCategoriaId);
  const setFiltroCategoria = useBibliotecaStore((state) => state.setFiltroCategoria);
  const criarCategoria = useBibliotecaStore((state) => state.criarCategoria);
  const renomearCategoria = useBibliotecaStore((state) => state.renomearCategoria);
  const moverCategoria = useBibliotecaStore((state) => state.moverCategoria);
  const removerCategoria = useBibliotecaStore((state) => state.removerCategoria);

  const [criandoNaRaiz, setCriandoNaRaiz] = useState(false);
  const [erroDeCriacao, setErroDeCriacao] = useState<string | null>(null);
  const [movendo, setMovendo] = useState<{ categoria: Categoria; definirErro: (mensagem: string | null) => void } | null>(null);
  const novaCategoriaRef = useRef<HTMLButtonElement>(null);
  const devolverFocoAoFantasmaRef = useRef(false);
  // Estado do PRÓPRIO componente (`useState`), não recomputado a cada
  // render — sobrevive a um re-render do painel (troca de filtro de status,
  // por exemplo) porque só muda quando o usuário clica em expandir/recolher.
  // Vazio = tudo expandido por padrão (o conjunto marca RECOLHIDOS, não
  // expandidos, para essa árvore nascer aberta sem precisar populá-lo com
  // todo id que existe).
  const [recolhidas, setRecolhidas] = useState<Set<string>>(new Set());

  const childrenIndex = useMemo(() => buildCategoriaChildrenIndex(categorias), [categorias]);
  const nosVisiveis = useMemo(() => flattenVisibleCategoriaTree(childrenIndex, recolhidas), [childrenIndex, recolhidas]);
  const parentById = useMemo(() => new Map(categorias.map((categoria) => [categoria.id, categoria.parentId])), [categorias]);
  // A contagem responde "quantos livros aparecem se eu clicar aqui", e a
  // estante compõe os DOIS filtros por "E" (status e categoria — ver
  // `ConteudoDeBiblioteca.tsx`). Contar sobre a estante crua fazia o número
  // mentir assim que um filtro de status estivesse ativo: "Fantasia" dizia 3
  // com o filtro em "Lendo", e clicar mostrava 1. Contar sobre a estante já
  // filtrada por status é o que faz o número e a tela concordarem sempre.
  const livrosNoStatusAtual = useMemo(() => filtrarLivros(livros, filtro), [livros, filtro]);
  const contagens = useMemo(
    () => contarLivrosPorCategoria(categorias, categoriasPorLivro, livrosNoStatusAtual),
    [categorias, categoriasPorLivro, livrosNoStatusAtual],
  );

  // O filtro ativo precisa estar VISÍVEL: ao selecionar (por aqui ou por
  // qualquer outro lugar que mude `filtroCategoriaId`), os ancestrais
  // expandem. Só reage à troca de filtro — se depois o usuário recolher o
  // pai de novo, a linha do pai passa a mostrar "contém o filtro atual".
  useEffect(() => {
    if (filtroCategoriaId === null) return;
    const ancestrais = ancestraisDe(filtroCategoriaId, parentById);
    setRecolhidas((atual) => {
      if (!ancestrais.some((id) => atual.has(id))) return atual;
      const proximo = new Set(atual);
      for (const id of ancestrais) proximo.delete(id);
      return proximo;
    });
  }, [filtroCategoriaId, parentById]);

  useEffect(() => {
    if (criandoNaRaiz || !devolverFocoAoFantasmaRef.current) return;
    devolverFocoAoFantasmaRef.current = false;
    novaCategoriaRef.current?.focus();
  }, [criandoNaRaiz]);

  function alternarRecolhimento(id: string) {
    setRecolhidas((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(id)) proximo.delete(id);
      else proximo.add(id);
      return proximo;
    });
  }

  function expandir(id: string) {
    setRecolhidas((atual) => {
      if (!atual.has(id)) return atual;
      const proximo = new Set(atual);
      proximo.delete(id);
      return proximo;
    });
  }

  function contemFiltro(no: CategoriaFlatNode): boolean {
    if (filtroCategoriaId === null || !no.hasChildren || !recolhidas.has(no.categoria.id)) return false;
    return getCategoriaDescendantIds(no.categoria.id, childrenIndex).has(filtroCategoriaId);
  }

  async function confirmarCriacaoNaRaiz(nome: string, viaTeclado: boolean): Promise<boolean> {
    if (nome === "") {
      devolverFocoAoFantasmaRef.current = viaTeclado;
      setCriandoNaRaiz(false);
      return true;
    }
    try {
      // Sem parentId: a store manda `null` explícito ao IPC — cria na raiz.
      await criarCategoria(nome);
      devolverFocoAoFantasmaRef.current = viaTeclado;
      setCriandoNaRaiz(false);
      setErroDeCriacao(null);
      return true;
    } catch (error) {
      setErroDeCriacao(messageFor(error, "Não foi possível criar a categoria."));
      return false;
    }
  }

  async function moverPara(novoParentId: string | null) {
    if (!movendo) return;
    const { categoria, definirErro } = movendo;
    setMovendo(null);
    try {
      await moverCategoria(categoria.id, novoParentId);
      definirErro(null);
      // A categoria movida continua onde o usuário consegue vê-la: o novo pai
      // expande. Se ela era o filtro, continua sendo — a store não mexe nisso.
      if (novoParentId !== null) expandir(novoParentId);
    } catch (error) {
      definirErro(messageFor(error, "Não foi possível mover a categoria."));
    }
  }

  const todasAtiva = filtroCategoriaId === null;

  return (
    <div className="mt-3 border-t border-border pt-2">
      <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Categorias</h3>

      <ul className="flex flex-col">
        <li>
          <button
            type="button"
            onClick={() => setFiltroCategoria(null)}
            aria-current={todasAtiva ? "true" : undefined}
            className={`flex w-full items-center rounded-sm border-l-2 py-0.5 pr-1 text-left text-sm transition-transform active:scale-97
              ${todasAtiva ? LINHA_ATIVA : LINHA_EM_REPOUSO}`}
          >
            <span aria-hidden="true" className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate px-1 py-0.5">Todas as categorias</span>
            {/* `livrosNoStatusAtual`, nao `livros`: "Todas as categorias"
                tambem responde "quantos aparecem se eu clicar aqui", e clicar
                nao desliga o filtro de status — so o de categoria. */}
            <span aria-hidden="true" className="w-12 shrink-0 pr-1 text-right text-xs tabular-nums text-ink-muted">
              {livrosNoStatusAtual.length}
            </span>
            <span className="sr-only">, {formatarContagemDeLivros(livrosNoStatusAtual.length)}</span>
          </button>
        </li>
        {nosVisiveis.map((no) => (
          <LinhaDeCategoria
            key={no.categoria.id}
            categoria={no.categoria}
            depth={no.depth}
            temFilhos={no.hasChildren}
            recolhida={recolhidas.has(no.categoria.id)}
            contagem={contagens.get(no.categoria.id) ?? 0}
            onAlternarRecolhimento={() => alternarRecolhimento(no.categoria.id)}
            onExpandir={() => expandir(no.categoria.id)}
            selecionada={filtroCategoriaId === no.categoria.id}
            contemFiltro={contemFiltro(no)}
            onSelecionar={() => setFiltroCategoria(no.categoria.id)}
            onRenomear={(nome) => renomearCategoria(no.categoria.id, nome)}
            onRemover={() => removerCategoria(no.categoria.id)}
            onCriarFilha={(nome) => criarCategoria(nome, no.categoria.id)}
            onSolicitarMover={(definirErro) => setMovendo({ categoria: no.categoria, definirErro })}
          />
        ))}
        <li className="mt-2">
          {criandoNaRaiz ? (
            <>
              <div className="flex items-center border-l-2 border-transparent py-0.5 pr-1">
                <span aria-hidden="true" className="size-5 shrink-0" />
                <CampoDeNomeInline
                  rotulo="Nome da nova categoria"
                  placeholder="Nova categoria"
                  valorInicial=""
                  onConfirmar={confirmarCriacaoNaRaiz}
                  onCancelar={() => {
                    devolverFocoAoFantasmaRef.current = true;
                    setErroDeCriacao(null);
                    setCriandoNaRaiz(false);
                  }}
                />
              </div>
              {erroDeCriacao ? (
                <p role="alert" className="ml-6 py-0.5 text-xs text-terracotta-ink">
                  {erroDeCriacao}
                </p>
              ) : null}
            </>
          ) : (
            <button
              ref={novaCategoriaRef}
              type="button"
              onClick={() => {
                setErroDeCriacao(null);
                setCriandoNaRaiz(true);
              }}
              className="flex w-full items-center gap-2 rounded-sm border-l-2 border-transparent px-2 py-1 text-left text-sm text-ink-muted
                transition-transform hover:bg-surface-raised hover:text-ink active:scale-97"
            >
              <span aria-hidden="true">+</span> Nova categoria
            </button>
          )}
        </li>
      </ul>

      <DialogoDeMoverCategoria
        categoria={movendo?.categoria ?? null}
        alvos={movendo ? categoriaMoveTargets(movendo.categoria.id, categorias) : []}
        onMover={moverPara}
        onFechar={() => setMovendo(null)}
      />
    </div>
  );
}

/**
 * O painel da seção Biblioteca: os quatro filtros de status no topo e
 * "Importar livro…" no rodapé — mesmo esqueleto de `PainelDeCartoes`
 * ("Todos os baralhos" + ação no rodapé), com status de leitura no lugar da
 * árvore de baralhos.
 */
export function PainelDeBiblioteca() {
  const status = useBibliotecaStore((state) => state.status);
  const errorMessage = useBibliotecaStore((state) => state.errorMessage);
  const load = useBibliotecaStore((state) => state.load);
  const livros = useBibliotecaStore((state) => state.livros);
  const filtro = useBibliotecaStore((state) => state.filtro);
  const setFiltro = useBibliotecaStore((state) => state.setFiltro);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === "loading" || status === "idle") {
    return <p className="px-4 py-3 text-sm text-ink-muted">Carregando a estante…</p>;
  }

  if (status === "error") {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar a biblioteca."}
      </p>
    );
  }

  const contagem = contarPorStatus(livros);

  return (
    <nav
      aria-label="Biblioteca"
      data-slot="filtro-biblioteca"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2"
    >
      <ul className="flex flex-col">
        {FILTROS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => setFiltro(item.id)}
              aria-current={filtro === item.id ? "true" : undefined}
              className={`flex w-full items-center gap-1 rounded-sm border-l-2 py-1 pl-2 pr-2 text-left text-sm transition-transform active:scale-97
                ${filtro === item.id ? LINHA_ATIVA : LINHA_EM_REPOUSO}`}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{item.rotulo}</span>
              <span className="shrink-0 text-xs tabular-nums text-ink-muted">{contagem[item.id]}</span>
            </button>
          </li>
        ))}
      </ul>

      <SecaoDeCategorias />

      <div className="mt-auto border-t border-border pt-2">
        <ImportarLivroButton variante="painel" />
      </div>

      {errorMessage ? (
        <p role="alert" className="px-2 pt-2 text-xs text-terracotta-ink">
          {errorMessage}
        </p>
      ) : null}
    </nav>
  );
}
