import { memo, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Handle, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import { resolveMediaSrc, storeMediaFile } from "../editor/blocks/media/media-storage";
import { IMAGE_MAX_BYTES, IMAGE_MIME_TYPES, validateMediaFile } from "../editor/blocks/media/media-validation";
import { useCriarCartaoDeNoStore } from "./criar-cartao-de-no-store";
import { useRecuperacaoStore } from "./recuperacao-store";
import { useMapaMentalStore, type NoDoMapa } from "./store";

/**
 * O cartão de um nó do mapa mental.
 *
 * Um handle "source" em cada lado — nunca "target": `ConteudoDeMapaMental`
 * liga `<ReactFlow connectionMode="loose">`, e em modo "loose" dois handles
 * "source" podem se conectar entre si (é a exceção que o próprio tipo de
 * `Connection` documenta: loose permite fonte-fonte, só não alvo-alvo). Com
 * todo handle "source", qualquer lado de qualquer cartão liga em qualquer
 * lado de outro — não existe hierarquia fonte→destino num mapa mental, e não
 * teria sentido obrigar o usuário a lembrar qual lado é "de saída".
 *
 * Cada handle tem um `id` ÚNICO ("top"/"right"/"bottom"/"left") — é o que o
 * defeito relatado (só o lado de cima ligava, sempre numa curva feia por
 * cima) estava sem: o `@xyflow/react` escolhe QUAL handle desenhar (posição
 * de origem/destino da linha) por esse id (`getHandle`, em
 * `@xyflow/system`), e sem ids únicos por nó ele sempre caía no primeiro
 * handle declarado (o de cima), não importa de qual lado o usuário arrastou
 * de verdade — a ligação em si acontecia, só o DESENHO ficava errado.
 * `ConteudoDeMapaMental`'s `handleConnect`/`store.ts`'s `conectar` persistem
 * esses ids dentro de `mindmap_edges.style` (JSON livre, sem migração nova)
 * pra a aresta lembrar de que lado saiu/chegou depois de um reload — ver
 * `handlesDoEstilo` em `store.ts`.
 *
 * `shape` (coluna do banco) não aparece aqui de propósito: não há UI para
 * defini-la nesta rodada. `color` (a cor do RAMO) já tem UI: vira o
 * atributo `data-cor`, que `mapa-mental.css` lê pra colorir borda e fundo —
 * nunca via `style` inline (proibido pelas regras do projeto) e nunca no
 * TEXTO, que fica sempre `--ink` (ver o "porquê" completo em
 * `cores-de-ramo.ts`). Enquanto selecionado, `data-cor` some de propósito:
 * o destaque de seleção (borda âmbar) precisa ficar visível não importa a
 * cor do ramo, e como `mapa-mental.css` não é uma folha em `@layer`, ela
 * venceria a classe Tailwind de seleção se o atributo continuasse presente.
 *
 * `icon` também não aparece — é um glifo de emoji curto, papel bem diferente
 * de `image` (a FOTO do cartão, defeito B do relatório), que aparece logo
 * abaixo. `image` reusa o MESMO armazenamento do editor de blocos
 * (`media-storage.ts`: grava em `media/`, deduplicado por hash) por meio de
 * `useMapaMentalStore().definirImagemDoNo` — nenhum segundo jeito de guardar
 * arquivo neste app.
 */
function CartaoNodeComponent({ id, data, selected }: NodeProps<NoDoMapa>) {
  const renomearNo = useMapaMentalStore((state) => state.renomearNo);
  const definirImagemDoNo = useMapaMentalStore((state) => state.definirImagemDoNo);
  const pendingEditNoId = useMapaMentalStore((state) => state.pendingEditNoId);
  const consumePendingEditNo = useMapaMentalStore((state) => state.consumePendingEditNo);
  const abrirCriarCartao = useCriarCartaoDeNoStore((state) => state.abrir);

  // Nó raiz = nenhuma aresta chega nele. É a deixa de contexto do modo de
  // recuperação (briefing, item 1): escondendo TUDO não sobraria nada para
  // ancorar a lembrança do resto do mapa. Calculado aqui (não guardado em
  // `data`) pelo mesmo motivo de `arestasComCor` em `ConteudoDeMapaMental`:
  // é puramente derivado de `arestas`, guardá-lo à parte só criaria mais um
  // jeito de os dois ficarem dessincronizados.
  const souRaiz = useMapaMentalStore((state) => !state.arestas.some((aresta) => aresta.target === id));

  const modoRecuperacaoAtivo = useRecuperacaoStore((state) => state.ativo);
  const revelado = useRecuperacaoStore((state) => state.revelados.has(id));
  const emFoco = useRecuperacaoStore((state) => state.focoId === id);
  const revelar = useRecuperacaoStore((state) => state.revelar);

  // Some o texto quando: o modo está ligado, o nó NÃO é o raiz, e o usuário
  // ainda não pediu para ver este nó específico (ou todos, via "Revelar
  // tudo" — que só preenche `revelados`, sem ramo especial aqui).
  const textoEscondido = modoRecuperacaoAtivo && !souRaiz && !revelado;

  const [editando, setEditando] = useState(false);
  const [rascunho, setRascunho] = useState(data.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editando) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editando]);

  // `data.image` é só o NOME do arquivo em `media/` (o que persiste), nunca
  // uma URL exibível — precisa passar por `resolveMediaSrc` antes de ir num
  // `src`, mesmo padrão de `FileThumbnail` em
  // `databases/properties/files/FilesCell.tsx`. `cancelado` evita que uma
  // resolução antiga (imagem trocada de novo enquanto a primeira ainda
  // resolvia) sobrescreva a URL mais nova depois de já ter perdido a corrida.
  const [urlImagem, setUrlImagem] = useState("");
  useEffect(() => {
    if (!data.image) {
      setUrlImagem("");
      return;
    }
    let cancelado = false;
    void resolveMediaSrc(data.image).then((url) => {
      if (!cancelado) setUrlImagem(url);
    });
    return () => {
      cancelado = true;
    };
  }, [data.image]);

  const [erroImagem, setErroImagem] = useState<string | null>(null);
  const inputImagemRef = useRef<HTMLInputElement>(null);

  async function selecionarImagem(file: File): Promise<void> {
    const validacao = validateMediaFile(file, IMAGE_MIME_TYPES, IMAGE_MAX_BYTES);
    if (!validacao.ok) {
      setErroImagem(validacao.reason ?? "Imagem inválida.");
      return;
    }
    setErroImagem(null);
    const armazenada = await storeMediaFile(file);
    await definirImagemDoNo(id, armazenada.src);
  }

  function handleArquivoDeImagemEscolhido(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    // Limpa o valor do input mesmo sem arquivo escolhido (cancelou o
    // diálogo) — sem isto, escolher o MESMO arquivo duas vezes seguidas não
    // dispara `onChange` na segunda vez (o navegador só avisa quando o
    // valor muda).
    event.currentTarget.value = "";
    if (!file) return;
    void selecionarImagem(file);
  }

  function iniciarEdicao() {
    // Modo de recuperação é LEITURA (briefing, item 1): nenhuma escrita nova
    // pode nascer dele, e permitir editar o texto aqui seria exatamente
    // isso — sem contar que editaria o rótulo que o usuário está tentando
    // LEMBRAR, o que destruiria o próprio exercício.
    if (modoRecuperacaoAtivo) return;
    setRascunho(data.label);
    setEditando(true);
  }

  // O nó nasce pronto pra ser renomeado quando `pendingEditNoId` aponta pra
  // ele — o raiz de um mapa novo (item 1 do briefing), ou o filho/irmão que
  // acabou de nascer de Tab/Enter (item 2). Mesmo padrão de
  // `pendingRenameId`/`LinhaDoMapa` em `PainelDeMapaMental.tsx`, só que para
  // um cartão do canvas em vez de uma linha da lista. `iniciarEdicao` e
  // `consumePendingEditNo` ficam fora das dependências de propósito: não
  // mudam de comportamento entre renders, e incluí-las disparava o efeito de
  // novo sem nenhuma mudança real de estado pra reagir.
  useEffect(() => {
    if (pendingEditNoId === id) {
      iniciarEdicao();
      consumePendingEditNo(id);
    }
  }, [pendingEditNoId, id]);

  async function confirmarEdicao() {
    setEditando(false);
    const rotulo = rascunho.trim();
    if (!rotulo || rotulo === data.label) return;
    await renomearNo(id, rotulo);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setEditando(false);
      setRascunho(data.label);
    }
    // Sem isto, o MESMO Enter que confirma esta edição borbulharia até o
    // `onKeyDown` de `CanvasDoMapa` e disparia "criar irmão" — Tab teria o
    // mesmo problema com "criar filho". O guard de `CanvasDoMapa` (que olha
    // a tag do alvo do evento) já bastaria sozinho, mas isto documenta a
    // intenção no próprio lugar onde o Enter é consumido.
    event.stopPropagation();
  }

  // Destaque do cartão: fora do modo de recuperação é a seleção normal
  // (âmbar, já existia). DENTRO do modo, a seleção normal fica sem sentido
  // (o clique agora serve para revelar, não para editar/ligar) e quem
  // importa mostrar é o CURSOR de navegação por teclado — token `focus`
  // (mesmo anel usado em `:focus-visible` no resto do app), nunca a cor do
  // ramo (`data-cor` já some abaixo pelo mesmo motivo de antes).
  const destaque = modoRecuperacaoAtivo
    ? emFoco
      ? "border-focus bg-surface-raised"
      : "border-border bg-surface"
    : selected
      ? "border-amber bg-surface-raised"
      : "border-border bg-surface";

  return (
    <div
      data-cor={!selected && !modoRecuperacaoAtivo ? (data.color ?? undefined) : undefined}
      // Só existe (e só importa) dentro do modo de recuperação — é o gancho
      // que `mapa-mental.css` poderia usar para o anel de foco por CSS puro
      // (hoje feito via classe Tailwind em `destaque`) e o que os testes
      // usam para achar "qual nó está sob o cursor de teclado agora",
      // seguindo o mesmo padrão de `data-cor` (atributo, não classe, para
      // não depender do nome interno de uma classe Tailwind).
      data-foco={modoRecuperacaoAtivo && emFoco ? "true" : undefined}
      onDoubleClick={iniciarEdicao}
      className={["mapa-mental-no min-w-32 max-w-64 rounded-sm border px-3 py-2 text-sm text-ink shadow-hard-sm", destaque].join(
        " ",
      )}
    >
      {/* `isVisible` explícito (não o padrão do componente) para também
          esconder durante a edição do rótulo — um botão "Criar cartão"
          flutuando sobre um `<input>` em edição seria ruído, não ajuda. Só
          o RÓTULO viaja para a store: um nó de mapa mental não é um bloco,
          então o cartão nascido daqui nunca tem link de volta — ver
          `criar-cartao-de-no-store.ts`. Também some inteiro no modo de
          recuperação: "Criar cartão" é uma escrita, e o modo é LEITURA. */}
      <NodeToolbar
        isVisible={selected && !editando && !modoRecuperacaoAtivo}
        position={Position.Top}
        className="nodrag flex gap-1"
      >
        <button
          type="button"
          onClick={() => abrirCriarCartao(data.label)}
          className="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
        >
          Criar cartão
        </button>
        <button
          type="button"
          onClick={() => inputImagemRef.current?.click()}
          className="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
        >
          {data.image ? "Trocar imagem" : "Adicionar imagem"}
        </button>
        {data.image && (
          <button
            type="button"
            onClick={() => void definirImagemDoNo(id, null)}
            className="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
          >
            Remover imagem
          </button>
        )}
        {/* `hidden` (não CSS de esconder por fora): mantém o elemento fora do
            fluxo sem precisar de mais uma classe, e o clique real acontece
            sempre pelo botão acima via `.click()` programático — o mesmo
            desenho de `media-node-view.ts`'s `renderPicker`. */}
        <input
          ref={inputImagemRef}
          type="file"
          accept={IMAGE_MIME_TYPES.join(",")}
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={handleArquivoDeImagemEscolhido}
        />
        {erroImagem && (
          <p role="alert" className="w-full text-xs text-terracotta-ink">
            {erroImagem}
          </p>
        )}
      </NodeToolbar>
      {/* Handles também somem no modo de recuperação: `ConteudoDeMapaMental`
          já desliga `nodesConnectable` (a ligação de verdade não acontece
          mais), então deixá-los visíveis só seria ruído sobre um cartão que
          o usuário está tentando ler/lembrar. */}
      {!modoRecuperacaoAtivo && (
        <>
          {/* `id` único por handle — ver o comentário de topo sobre o
              defeito A ("só o lado de cima ligava"). Os quatro ids também
              são o que `conectar`/`handlesDoEstilo` em `store.ts` gravam e
              releem de `mindmap_edges.style`, pra aresta lembrar de que lado
              saiu/chegou depois de um reload. */}
          <Handle id="top" type="source" position={Position.Top} />
          <Handle id="right" type="source" position={Position.Right} />
          <Handle id="bottom" type="source" position={Position.Bottom} />
          <Handle id="left" type="source" position={Position.Left} />
        </>
      )}
      {!textoEscondido && data.image && urlImagem && (
        // Decorativo: o rótulo do nó (texto ou campo em edição, logo
        // abaixo) já descreve o cartão — um `alt` aqui duplicaria o anúncio
        // pro leitor de tela. Mesmo raciocínio de `FileThumbnail` em
        // `databases/properties/files/FilesCell.tsx`.
        <img src={urlImagem} alt="" className="mb-2 h-24 w-full rounded-sm object-cover" />
      )}
      {editando ? (
        <input
          ref={inputRef}
          value={rascunho}
          onChange={(event) => setRascunho(event.currentTarget.value)}
          onBlur={() => void confirmarEdicao()}
          onKeyDown={handleKeyDown}
          aria-label={`Texto de ${data.label}`}
          // "nodrag": sem isto, clicar/arrastar o cursor dentro do campo pra
          // selecionar texto é interpretado pelo `@xyflow/react` como
          // arrastar o NÓ inteiro pelo canvas.
          className="nodrag w-full min-w-0 border-none bg-transparent p-0 text-sm text-ink outline-none"
        />
      ) : textoEscondido ? (
        // O clique aqui é a única "escrita" que este botão faz: `revelar`
        // só mexe em `useRecuperacaoStore` (nunca em IPC) — ver o comentário
        // de topo de `recuperacao-store.ts`. `type="button"` + `nodrag`
        // pelo mesmo motivo do `<input>` acima: sem isto o clique seria lido
        // como início de arrasto do nó.
        <button
          type="button"
          onClick={() => revelar(id)}
          // O rótulo do BOTÃO nunca pode conter `data.label`: um leitor de
          // tela anunciaria a resposta antes do clique, o que anularia a
          // recuperação ativa (a mesma razão de o texto sumir visualmente).
          aria-label="Nó oculto. Clique para revelar."
          className="nodrag flex w-full items-center justify-center rounded-sm border border-dashed border-border py-1 text-ink-muted transition-colors duration-150 ease-out hover:bg-surface-raised hover:text-ink motion-reduce:transition-none"
        >
          <span aria-hidden="true">•••</span>
        </button>
      ) : (
        <p className="break-words">{data.label}</p>
      )}
    </div>
  );
}

export const CartaoNode = memo(CartaoNodeComponent);
