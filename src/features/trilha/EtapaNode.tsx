import { memo, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { Handle, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import { AppError, type ImpactoDaTroca } from "../../lib/ipc";
import { useCartoesStore } from "../cartoes/store";
import { usePageTreeStore } from "../pages/store";
import { displayTitle } from "../pages/tree-utils";
import {
  bloqueadorasNaoConcluidas,
  caminhosDescartadosPara,
  decisoesPendentesPara,
  estadoVisualDaEtapa,
  rotulosDosCaminhosQueSaem,
  type EstadoVisualDaEtapa,
} from "./descricoes";
import { useTrilhaStore } from "./store";
import type { EstiloComVariaveisCss, NoDeEtapa } from "./tipos-do-canvas";

/**
 * Mesmo formato de `messageFor` em `store.ts` — não é exportado de lá (é uma
 * função privada do closure da store), e duplicar três linhas custa menos
 * que criar acoplamento novo com quem é dono daquele arquivo nesta entrega.
 */
function mensagemDoErro(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

/**
 * O `<select>` de tipo de material só tem duas `<option>` ("page"/"deck"),
 * então `event.currentTarget.value` já é sempre uma das duas — mas o DOM
 * devolve `string`, não a união. Um type guard em vez de `as` mantém a
 * garantia verificada em runtime na própria origem do valor, sem calar o
 * compilador.
 */
function ehTipoDeMaterialAnexavel(valor: string): valor is "page" | "deck" {
  return valor === "page" || valor === "deck";
}

const CLASSE_POR_ESTADO: Record<EstadoVisualDaEtapa, string> = {
  disponivel: "trilha-etapa--disponivel",
  bloqueada: "trilha-etapa--bloqueada",
  "em-andamento": "trilha-etapa--em-andamento",
  concluida: "trilha-etapa--concluida",
  "em-ciclo": "trilha-etapa--em-ciclo",
};

/**
 * Texto de uma linha para `.trilha-etapa__meta` — nunca data (proibido pelo
 * design), só o estado em palavras. Bloqueada diz QUAIS etapas faltam, pelo
 * nome (item 2 do pedido: "Falta 1 etapa" sem dizer qual não orienta
 * ninguém); a linha corta com reticências quando não cabe, e a cadeia
 * realçada no hover mostra o resto.
 */
function textoDeMeta(estado: EstadoVisualDaEtapa, faltando: readonly string[]): string {
  switch (estado) {
    case "concluida":
      return "Concluída";
    case "em-andamento":
      return "Em andamento";
    case "em-ciclo":
      return "Em ciclo — precisa de correção";
    case "bloqueada":
      if (faltando.length === 0) return "Bloqueada";
      return faltando.length === 1 ? `Falta: ${faltando[0]}` : `Faltam ${faltando.length}: ${faltando.join(", ")}`;
    case "disponivel":
      return "Disponível";
  }
}

/**
 * O cartão de uma etapa. Todo texto que a marca (`::before`, CSS puro) diz
 * por forma/cor já está escrito em algum lugar acessível: `data-estado`
 * mais o `aria-label` do NÓ (posto por `TrilhaCanvas.tsx` a partir de
 * `descricaoParaLeitorDeTela`, porque é o `Node.ariaLabel` — fora de
 * `data` — que o `@xyflow/react` lê para o `aria-label` do wrapper focável).
 *
 * O `NodeToolbar` (mesmo padrão de `CartaoNode.tsx`) só aparece com a etapa
 * selecionada, e é a ÚNICA superfície de ação: nenhum `onClick` no cartão em
 * si. `disponivel`/`bloqueada` decidem se "Começar"/"Concluir" aparecem —
 * uma etapa bloqueada não ganha esses botões, para não convidar uma ação que
 * o backend rejeitaria; a lista de bloqueadoras (com "Remover") continua
 * visível de qualquer forma, porque é o caminho de sair do bloqueio —
 * inclusive o de sair de um CICLO (a bloqueadora aparece igual, apagável
 * igual — ver a nota completa em `TrilhaCanvas.tsx`).
 *
 * `situacaoNoCaminho` é um eixo à parte de `estado` (ver o comentário do
 * tipo em descricoes.ts): uma etapa "descartada" ou "aguardandoEscolha"
 * mostra o cartão normal do estado dela por cima, mais um selo e uma frase.
 * A barra de "escolher caminho" só existe quando a PRÓPRIA etapa é uma
 * decisão (`trilha.decisoes` tem uma linha para o id dela) — nada disso
 * mexe no fluxo de bloqueadora/material que já existia.
 */
function EtapaNodeComponent({ id, data, selected }: NodeProps<NoDeEtapa>) {
  const { etapa, cor, marco = false, proxima = false } = data;
  const estado = estadoVisualDaEtapa(etapa);
  const desbloqueada = estado === "disponivel" || estado === "em-andamento";
  const situacao = etapa.situacaoNoCaminho;

  const todasEtapas = useTrilhaStore((state) => state.trilha?.etapas ?? []);
  const todasFlechas = useTrilhaStore((state) => state.trilha?.flechas ?? []);
  const raias = useTrilhaStore((state) => state.trilha?.raias ?? []);
  const materiais = useTrilhaStore((state) => state.trilha?.materiais ?? []);
  const decisoes = useTrilhaStore((state) => state.trilha?.decisoes ?? []);
  const marcarProgresso = useTrilhaStore((state) => state.marcarProgresso);
  const desmarcarProgresso = useTrilhaStore((state) => state.desmarcarProgresso);
  const criarFlecha = useTrilhaStore((state) => state.criarFlecha);
  const apagarFlecha = useTrilhaStore((state) => state.apagarFlecha);
  const moverEtapaParaRaia = useTrilhaStore((state) => state.moverEtapaParaRaia);
  const anexarMaterial = useTrilhaStore((state) => state.anexarMaterial);
  const removerMaterial = useTrilhaStore((state) => state.removerMaterial);
  const maturidadesPorBaralho = useTrilhaStore((state) => state.maturidadesPorBaralho);
  const carregarMaturidadeDoBaralho = useTrilhaStore((state) => state.carregarMaturidadeDoBaralho);
  const escolherCaminho = useTrilhaStore((state) => state.escolherCaminho);
  const preverTrocaDeCaminho = useTrilhaStore((state) => state.preverTrocaDeCaminho);
  const marcarComoDecisao = useTrilhaStore((state) => state.marcarComoDecisao);
  const desmarcarDecisao = useTrilhaStore((state) => state.desmarcarDecisao);
  const renomearEtapa = useTrilhaStore((state) => state.renomearEtapa);
  const apagarEtapa = useTrilhaStore((state) => state.apagarEtapa);
  const pagesById = usePageTreeStore((state) => state.pagesById);
  const decksById = useCartoesStore((state) => state.decksById);
  /** Chave `null` é a coleção inteira (ver `deckCounts` em `lib/ipc.ts`) — nunca usada aqui, só as por-baralho. */
  const contagensDosBaralhos = useCartoesStore((state) => state.contagens);

  const [bloqueadoraEscolhida, setBloqueadoraEscolhida] = useState("");
  const [tipoDeMaterial, setTipoDeMaterial] = useState<"page" | "deck">("page");
  const [paginaParaMaterial, setPaginaParaMaterial] = useState("");
  const [deckParaMaterial, setDeckParaMaterial] = useState("");
  /** Rótulo aguardando confirmação de troca (o "Trocar para X?" ainda não decidido) — `null` fora desse fluxo. */
  const [rotuloEmTroca, setRotuloEmTroca] = useState<string | null>(null);
  /** A prévia já respondida para `rotuloEmTroca`. Só existe simultaneamente com ele. */
  const [impactoDaTroca, setImpactoDaTroca] = useState<ImpactoDaTroca | null>(null);
  /** Trava contra duplo-clique enquanto uma prévia ou uma escrita de escolha está em voo. */
  const [escolhendo, setEscolhendo] = useState(false);
  /** Mesmo padrão de `RaiaNode`/`PainelDeTrilha`: duplo clique no título entra, Enter confirma (via blur), Escape cancela. */
  const [renomeandoTitulo, setRenomeandoTitulo] = useState(false);
  const [rascunhoTitulo, setRascunhoTitulo] = useState(etapa.title);
  const tituloInputRef = useRef<HTMLInputElement>(null);
  /** Confirmação inline de apagar — nunca `window.confirm` (trava a WebView), mesmo padrão da troca de caminho acima. */
  const [confirmandoApagar, setConfirmandoApagar] = useState(false);

  const decisaoDestaEtapa = decisoes.find((decisao) => decisao.stepId === id) ?? null;
  const ehDecisao = decisaoDestaEtapa !== null;
  const rotulosDoCaminho = rotulosDosCaminhosQueSaem(id, todasFlechas);
  const decisoesPendentes = situacao === "aguardandoEscolha" ? decisoesPendentesPara(etapa, todasEtapas, todasFlechas, decisoes) : [];
  const caminhosDescartados = situacao === "descartado" ? caminhosDescartadosPara(etapa, todasEtapas, todasFlechas, decisoes) : [];

  const materiaisDaEtapa = materiais.filter((material) => material.stepId === id);
  /** Chave estável para o `useEffect` abaixo — string, não o array em si (uma
   *  nova referência a cada render não pode disparar a busca de novo). */
  const idsDeBaralhoDosMateriais = materiaisDaEtapa
    .filter((material) => material.kind === "deck" && material.deckId !== null)
    .map((material) => material.deckId)
    .join(",");

  /**
   * Busca a maturidade só quando o material de baralho de fato APARECE na
   * tela: o `NodeToolbar` que desenha a lista de materiais só existe com a
   * etapa selecionada (`isVisible={selected}` abaixo), então gatear aqui
   * também evita a "busca no mount de todo cartão" que uma trilha com 20+
   * etapas pagaria caro. A store (`carregarMaturidadeDoBaralho`) cacheia por
   * `deckId` e ignora um pedido para um baralho já em cache/carregando —
   * ver o comentário dela para a estratégia completa — então reabrir a mesma
   * etapa, ou selecionar em sequência duas etapas com o mesmo baralho, nunca
   * refaz a chamada IPC.
   */
  useEffect(() => {
    if (!selected || idsDeBaralhoDosMateriais === "") return;
    for (const deckId of idsDeBaralhoDosMateriais.split(",")) void carregarMaturidadeDoBaralho(deckId);
  }, [selected, idsDeBaralhoDosMateriais, carregarMaturidadeDoBaralho]);

  const idsPaginaJaAnexada = new Set(
    materiaisDaEtapa.filter((material) => material.kind === "page" && material.pageId !== null).map((material) => material.pageId),
  );
  const paginasParaAnexar = [...pagesById.values()].filter(
    (pagina) => pagina.id !== id && pagina.deleted_at === null && !idsPaginaJaAnexada.has(pagina.id),
  );
  const idsDeckJaAnexado = new Set(
    materiaisDaEtapa.filter((material) => material.kind === "deck" && material.deckId !== null).map((material) => material.deckId),
  );
  const decksParaAnexar = [...decksById.values()].filter((deck) => deck.deletedAt === null && !idsDeckJaAnexado.has(deck.id));

  function handleAnexarMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tipoDeMaterial === "page") {
      if (!paginaParaMaterial) return;
      void anexarMaterial(id, "page", paginaParaMaterial, null);
      setPaginaParaMaterial("");
    } else {
      if (!deckParaMaterial) return;
      void anexarMaterial(id, "deck", null, deckParaMaterial);
      setDeckParaMaterial("");
    }
  }

  function handleMudarTipoDeMaterial(event: ChangeEvent<HTMLSelectElement>) {
    const valor = event.currentTarget.value;
    if (!ehTipoDeMaterialAnexavel(valor)) return;
    setTipoDeMaterial(valor);
    // Troca de tipo descarta a seleção pendente do outro — evita anexar um
    // item do tipo errado se o usuário mudar de ideia sem limpar o select.
    setPaginaParaMaterial("");
    setDeckParaMaterial("");
  }

  // Sem percentual real vindo do contrato (só `in_progress`/`done`, nunca um
  // número) — 50 é só "está andando", não uma medida; ver a nota de decisão
  // em `ConteudoDeTrilha.tsx`/relatório desta entrega.
  const estiloDaBarraDeProgresso: EstiloComVariaveisCss = { "--progresso": estado === "em-andamento" ? 50 : 0 };

  const bloqueadoras = todasFlechas
    .filter((flecha) => flecha.blockedId === id)
    .map((flecha) => todasEtapas.find((candidata) => candidata.id === flecha.blockingId))
    .filter((candidata): candidata is (typeof todasEtapas)[number] => candidata !== undefined);

  const idsJaBloqueando = new Set(bloqueadoras.map((b) => b.id));
  const candidatasParaBloquear = todasEtapas.filter((candidata) => candidata.id !== id && !idsJaBloqueando.has(candidata.id));

  /**
   * Quem esta etapa bloqueia — o outro lado da cadeia. Junto com
   * `bloqueadoras` acima, é o que decide se apagar esta etapa deixa alguém
   * "no meio" de uma cadeia (A → esta → C): apagar remove as flechas dos dois
   * lados SEM religar A a C, e é essa consequência que `confirmandoApagar`
   * precisa nomear antes de escrever — nunca depois.
   */
  const dependentes = todasFlechas
    .filter((flecha) => flecha.blockingId === id)
    .map((flecha) => todasEtapas.find((candidata) => candidata.id === flecha.blockedId))
    .filter((candidata): candidata is (typeof todasEtapas)[number] => candidata !== undefined);
  const temCadeiaNosDoisLados = bloqueadoras.length > 0 && dependentes.length > 0;
  /** Subconjunto de `dependentes` para quem esta etapa é a ÚNICA bloqueadora — esses ficam sem bloqueadora nenhuma, e não só "com uma a menos". */
  const dependentesQueFicamSemBloqueadora = dependentes.filter(
    (dependente) => todasFlechas.filter((flecha) => flecha.blockedId === dependente.id).length === 1,
  );

  function handleLigar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bloqueadoraEscolhida) return;
    void criarFlecha(id, bloqueadoraEscolhida);
    setBloqueadoraEscolhida("");
  }

  /**
   * Escreve a escolha através da store: `escolherCaminho` já segue o funil
   * `executarEReler` (relê a trilha inteira em caso de sucesso, grava o
   * `errorMessage` global em caso de falha) e nunca rejeita — por isso não
   * há `try/catch` aqui, só o controle local de `escolhendo`.
   */
  async function escreverEscolha(pathLabel: string) {
    setEscolhendo(true);
    await escolherCaminho(id, pathLabel);
    setRotuloEmTroca(null);
    setImpactoDaTroca(null);
    setEscolhendo(false);
  }

  /**
   * REGRA DURA do pedido: trocar uma escolha que JÁ EXISTE por outra sempre
   * prevê o impacto antes — a confirmação (com os números) aparece no
   * próprio nó, nunca `window.confirm` (trava a WebView deste app). Só pula
   * direto para `escreverEscolha` em dois casos: a decisão ainda não tinha
   * escolha (nada para trocar, nada a avisar) ou a prévia diz que nenhuma
   * etapa que sairia do caminho tem progresso.
   */
  async function handleEscolherCaminho(pathLabel: string) {
    if (!decisaoDestaEtapa || decisaoDestaEtapa.chosenLabel === pathLabel || escolhendo) return;

    if (decisaoDestaEtapa.chosenLabel !== null) {
      setEscolhendo(true);
      setRotuloEmTroca(pathLabel);
      setImpactoDaTroca(null);
      try {
        const impacto = await preverTrocaDeCaminho(id, pathLabel);
        if (impacto.saemComProgresso.length === 0) {
          await escreverEscolha(pathLabel);
          return;
        }
        setImpactoDaTroca(impacto);
        setEscolhendo(false);
      } catch (error) {
        useTrilhaStore.setState({ errorMessage: mensagemDoErro(error, "Não foi possível avaliar o impacto da troca.") });
        setRotuloEmTroca(null);
        setEscolhendo(false);
      }
      return;
    }

    await escreverEscolha(pathLabel);
  }

  function handleCancelarTroca() {
    setRotuloEmTroca(null);
    setImpactoDaTroca(null);
  }

  useEffect(() => {
    if (renomeandoTitulo) {
      tituloInputRef.current?.focus();
      tituloInputRef.current?.select();
    }
  }, [renomeandoTitulo]);

  function iniciarRenomeacaoDoTitulo() {
    setRascunhoTitulo(etapa.title);
    setRenomeandoTitulo(true);
  }

  async function confirmarRenomeacaoDoTitulo() {
    setRenomeandoTitulo(false);
    const novoTitulo = rascunhoTitulo.trim();
    if (!novoTitulo || novoTitulo === etapa.title) return;
    await renomearEtapa(id, novoTitulo);
  }

  function handleKeyDownDoTitulo(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setRenomeandoTitulo(false);
      setRascunhoTitulo(etapa.title);
    }
  }

  function handleApagar() {
    setConfirmandoApagar(false);
    void apagarEtapa(id);
  }

  const classeDaSituacao =
    situacao === "aguardandoEscolha" ? "trilha-etapa--aguardando-escolha" : situacao === "descartado" ? "trilha-etapa--descartada" : null;

  return (
    <div
      className={[
        "trilha-etapa",
        cor ? `trilha-cor--${cor}` : null,
        CLASSE_POR_ESTADO[estado],
        ehDecisao ? "trilha-etapa--decisao" : null,
        marco ? "trilha-etapa--marco" : null,
        proxima ? "trilha-etapa--proxima" : null,
        classeDaSituacao,
      ]
        .filter(Boolean)
        .join(" ")}
      data-estado={estado}
      data-situacao-no-caminho={situacao}
    >
      {/* O CSS só desenha isto quando o estado é "em andamento" (ver trilha.css). */}
      <div className="trilha-etapa__progresso" style={estiloDaBarraDeProgresso} />

      {/* A bandeira do "você está aqui" (item 1 do pedido) — o único cartão
          da trilha que a carrega. Texto, não só o halo âmbar do CSS. */}
      {proxima ? <span className="trilha-etapa__aqui">{etapa.state === "in_progress" ? "Continue aqui" : "Comece aqui"}</span> : null}

      <NodeToolbar isVisible={selected} position={Position.Top} className="nodrag flex flex-col items-start gap-1.5 text-left">
        {/* Porta de entrada do fluxo inteiro: sem isto não existe caminho na
            tela para transformar uma etapa comum em decisão. Idempotente no
            backend (marcar) e recusado com erro visível (banner global) se
            ainda houver caminho rotulado saindo dela (desmarcar). */}
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => void (ehDecisao ? desmarcarDecisao(id) : marcarComoDecisao(id))}
            className="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
          >
            {ehDecisao ? "Desfazer decisão" : "Marcar como decisão"}
          </button>
        </div>

        {/* Escolher caminho: só existe na barra de uma DECISÃO, e a lista de
            rótulos vem das flechas que saem dela — nunca digitada à mão, para
            nunca oferecer um rótulo que nenhuma flecha usa. */}
        {ehDecisao && rotulosDoCaminho.length > 0 ? (
          <div className="w-56 rounded-sm border border-border bg-surface p-2 shadow-hard-sm">
            <p className="text-xs font-medium text-ink-muted">Escolher caminho:</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rotulosDoCaminho.map((rotulo) => {
                const ativo = decisaoDestaEtapa?.chosenLabel === rotulo;
                return (
                  <button
                    key={rotulo}
                    type="button"
                    aria-pressed={ativo}
                    disabled={escolhendo}
                    onClick={() => void handleEscolherCaminho(rotulo)}
                    className={[
                      "rounded-sm border px-2 py-1 text-xs font-medium shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 disabled:opacity-50 motion-reduce:transition-none",
                      ativo ? "border-emerald bg-emerald text-on-emerald" : "border-border bg-surface text-ink",
                    ].join(" ")}
                  >
                    {rotulo}
                  </button>
                );
              })}
            </div>

            {/* REGRA DURA: trocar uma escolha JÁ EXISTENTE sempre confirma
                aqui, com os números da prévia — nunca `window.confirm`. */}
            {rotuloEmTroca && impactoDaTroca ? (
              <div role="alertdialog" aria-label={`Confirmar troca de caminho para ${rotuloEmTroca}`} className="mt-1.5 rounded-sm border border-border bg-paper p-2">
                <p className="text-[11px] text-ink">
                  Trocar para "{rotuloEmTroca}" tira {impactoDaTroca.saemDoCaminho.length} etapa
                  {impactoDaTroca.saemDoCaminho.length === 1 ? "" : "s"} do caminho atual — {impactoDaTroca.saemComProgresso.length} com
                  progresso, {impactoDaTroca.saemConcluidas.length} já concluída{impactoDaTroca.saemConcluidas.length === 1 ? "" : "s"}.
                  Nada é apagado: voltar para a escolha atual traz tudo de volta.
                </p>
                <div className="mt-1.5 flex gap-1">
                  <button
                    type="button"
                    disabled={escolhendo}
                    onClick={() => void escreverEscolha(rotuloEmTroca)}
                    className="rounded-sm bg-emerald px-2 py-1 text-xs font-medium text-on-emerald transition-transform duration-150 ease-out active:scale-97 disabled:opacity-50 motion-reduce:transition-none"
                  >
                    Confirmar troca
                  </button>
                  <button
                    type="button"
                    disabled={escolhendo}
                    onClick={handleCancelarTroca}
                    className="rounded-sm border border-border px-2 py-1 text-xs text-ink-muted transition-transform duration-150 ease-out active:scale-97 disabled:opacity-50 motion-reduce:transition-none"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {desbloqueada || estado === "concluida" ? (
          <div className="flex gap-1">
            {etapa.state !== "in_progress" && estado !== "concluida" && desbloqueada ? (
              <button
                type="button"
                onClick={() => void marcarProgresso(id, "in_progress")}
                className="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
              >
                Começar
              </button>
            ) : null}
            {estado !== "concluida" && desbloqueada ? (
              <button
                type="button"
                onClick={() => void marcarProgresso(id, "done")}
                className="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
              >
                Concluir
              </button>
            ) : null}
            {etapa.state !== null ? (
              <button
                type="button"
                onClick={() => void desmarcarProgresso(id)}
                className="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
              >
                Desfazer
              </button>
            ) : null}
          </div>
        ) : null}

        {bloqueadoras.length > 0 ? (
          <div className="w-56 rounded-sm border border-border bg-surface p-2 shadow-hard-sm">
            <p className="text-xs font-medium text-ink-muted">Bloqueada por:</p>
            <ul className="mt-1 flex flex-col gap-1">
              {bloqueadoras.map((bloqueadora) => (
                <li key={bloqueadora.id} className="flex items-center justify-between gap-2 text-xs text-ink">
                  <span className="truncate">{bloqueadora.title}</span>
                  <button
                    type="button"
                    onClick={() => void apagarFlecha(id, bloqueadora.id)}
                    className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-ink-muted transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
                  >
                    Remover
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {candidatasParaBloquear.length > 0 ? (
          <form onSubmit={handleLigar} className="flex items-center gap-1 rounded-sm border border-border bg-surface p-1.5 shadow-hard-sm">
            <label htmlFor={`trilha-bloqueadora-de-${id}`} className="sr-only">
              Bloquear {etapa.title} por
            </label>
            <select
              id={`trilha-bloqueadora-de-${id}`}
              value={bloqueadoraEscolhida}
              onChange={(event) => setBloqueadoraEscolhida(event.currentTarget.value)}
              className="nodrag w-32 rounded-sm border border-border bg-paper px-1 py-1 text-xs text-ink"
            >
              <option value="">Bloquear por…</option>
              {candidatasParaBloquear.map((candidata) => (
                <option key={candidata.id} value={candidata.id}>
                  {candidata.title}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!bloqueadoraEscolhida}
              className="shrink-0 rounded-sm bg-emerald px-2 py-1 text-xs font-medium text-on-emerald transition-transform duration-150 ease-out active:scale-97 disabled:opacity-50 motion-reduce:transition-none"
            >
              Ligar
            </button>
          </form>
        ) : null}

        {/* Só existe raia para mover quando a trilha tem propriedade de
            agrupamento (`ativarRaias` na store) — sem isto `moverEtapaParaRaia`
            seria recusado pelo backend antes de qualquer escrita. */}
        {raias.length > 0 ? (
          <div className="flex items-center gap-1 rounded-sm border border-border bg-surface p-1.5 shadow-hard-sm">
            <label htmlFor={`trilha-raia-de-${id}`} className="sr-only">
              Mover {etapa.title} para a raia
            </label>
            <select
              id={`trilha-raia-de-${id}`}
              value={etapa.laneValue}
              onChange={(event) => void moverEtapaParaRaia(id, event.currentTarget.value)}
              className="nodrag w-32 rounded-sm border border-border bg-paper px-1 py-1 text-xs text-ink"
            >
              <option value="">Sem raia</option>
              {raias
                .filter((raia) => raia.laneValue.trim().length > 0)
                .map((raia) => (
                  <option key={raia.laneValue} value={raia.laneValue}>
                    {raia.laneValue}
                  </option>
                ))}
            </select>
          </div>
        ) : null}

        {/* Materiais: o que a etapa manda estudar — página ou baralho; livro
            fica fora desta rodada (o schema já tem `kind: 'book'` e
            `anexar_material_etapa` já aceita, mas não existe origem de
            "listar livros" plugada aqui ainda — ver o relatório da entrega).
            Lista + anexar, sempre juntos: sem lista não dá para ver o que já
            tem antes de anexar de novo. O formulário fica visível mesmo com
            zero itens disponíveis (select desabilitado) — antes ele sumia
            inteiro sem página nenhuma para oferecer, e era exatamente assim
            que "não dá para colocar card" acontecia: nem a opção de trocar
            para baralho existia. */}
        <div className="w-56 rounded-sm border border-border bg-surface p-2 shadow-hard-sm">
          <p className="text-xs font-medium text-ink-muted">Materiais:</p>
          {materiaisDaEtapa.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {materiaisDaEtapa.map((material) => {
                const paginaDoMaterial = material.kind === "page" && material.pageId ? pagesById.get(material.pageId) : undefined;
                const deckDoMaterial = material.kind === "deck" && material.deckId ? decksById.get(material.deckId) : undefined;
                const icone = material.kind === "page" ? "📄" : material.kind === "deck" ? "🗂️" : "📚";
                const rotulo =
                  material.kind === "page"
                    ? (paginaDoMaterial ? displayTitle(paginaDoMaterial) : "Página")
                    : material.kind === "deck"
                      ? (deckDoMaterial?.name ?? "Baralho")
                      : "Livro";
                // Fila de hoje do baralho: `aprendendo` + `revisar`, o mesmo
                // par que `ContadoresBadge` pinta de amber/mint como "pede
                // atenção"/"pronto para hoje". `novos` fica de fora de
                // propósito — cartão novo é disponível para introduzir, não
                // "devido"; contá-lo aqui inflaria o número toda vez que
                // alguém criasse notas no baralho, mesmo sem nada vencendo.
                // Usa `deckCounts` (o comando que já existe, o mesmo do
                // rail de baralhos) — nenhum comando novo foi criado.
                const contagemDoDeck = material.kind === "deck" && material.deckId ? contagensDosBaralhos.get(material.deckId) : undefined;
                const devidosHoje = contagemDoDeck ? contagemDoDeck.aprendendo + contagemDoDeck.revisar : null;
                // `undefined` (nunca pedido — só possível se o `useEffect`
                // acima ainda não rodou neste primeiro paint) cai no mesmo
                // texto de "carregando": a diferença dura um quadro, não
                // vale um quinto estado visual.
                const estadoDeMaturidade =
                  material.kind === "deck" && material.deckId ? maturidadesPorBaralho.get(material.deckId) : undefined;
                // Variável tipada, não objeto literal direto em `style={}`: a
                // mesma convenção de `estiloDaBarraDeProgresso` acima e de
                // `FundoDeNiveisNode.tsx` — `style` do DOM não conhece
                // `--fracao-maduros`, e um literal inline exigiria `as`
                // (regra 2) só para calar o excess-property-check do JSX.
                const estiloDaMaturidade: EstiloComVariaveisCss =
                  estadoDeMaturidade?.status === "pronta"
                    ? { "--fracao-maduros": Math.round(estadoDeMaturidade.maturidade.fracaoMaduros * 100) }
                    : {};
                return (
                  <li key={material.id} className="flex flex-col gap-0.5 text-xs text-ink">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1">
                        <span aria-hidden="true">{icone}</span>
                        <span className="truncate">{rotulo}</span>
                        {devidosHoje !== null && devidosHoje > 0 ? (
                          <span
                            className="shrink-0 rounded-sm bg-mint/10 px-1 py-0.5 text-[10px] font-medium text-mint-ink"
                            // Plural de "cartão" é "cartões", não "cartãos" —
                            // por isso a palavra inteira troca, em vez de só
                            // apendar "s" (o mesmo padrão de `textoDeMeta`
                            // acima, que também escolhe a palavra certa em vez
                            // de concatenar).
                            aria-label={`${devidosHoje} ${devidosHoje === 1 ? "cartão devido" : "cartões devidos"} hoje`}
                          >
                            {devidosHoje}
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        onClick={() => void removerMaterial(material.id)}
                        className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-ink-muted transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
                      >
                        Remover
                      </button>
                    </div>

                    {/* Maturidade (item 2 do pedido): distinta de "devidos
                        hoje" acima — aquilo é fila de estudo, isto é "quanto
                        já foi de fato aprendido". Só existe para material de
                        baralho; página/livro não têm o conceito. */}
                    {material.kind === "deck" && material.deckId ? (
                      estadoDeMaturidade === undefined || estadoDeMaturidade.status === "carregando" ? (
                        <p className="pl-5 text-[10px] text-ink-muted">Calculando maturidade…</p>
                      ) : estadoDeMaturidade.status === "erro" ? (
                        <p className="pl-5 text-[10px] text-terracotta-ink">{estadoDeMaturidade.mensagem}</p>
                      ) : estadoDeMaturidade.maturidade.total === 0 ? (
                        <p className="pl-5 text-[10px] text-ink-muted">Baralho vazio — nada para amadurecer ainda.</p>
                      ) : (
                        <div className="trilha-material__maturidade pl-5" style={estiloDaMaturidade}>
                          <span className="trilha-material__maturidade-trilho" aria-hidden="true">
                            <span className="trilha-material__maturidade-cheio" />
                          </span>
                          <span className="text-[10px] text-ink-muted">
                            {estadoDeMaturidade.maturidade.maduros} de {estadoDeMaturidade.maturidade.total} maduros — já
                            lembra disso faz tempo
                          </span>
                        </div>
                      )
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-1 text-[11px] text-ink-muted">Nenhum ainda.</p>
          )}

          <form onSubmit={handleAnexarMaterial} className="nodrag mt-1.5 flex items-center gap-1">
            <label htmlFor={`trilha-tipo-material-de-${id}`} className="sr-only">
              Tipo de material para {etapa.title}
            </label>
            <select
              id={`trilha-tipo-material-de-${id}`}
              value={tipoDeMaterial}
              onChange={handleMudarTipoDeMaterial}
              className="w-20 shrink-0 rounded-sm border border-border bg-paper px-1 py-1 text-xs text-ink"
            >
              <option value="page">Página</option>
              <option value="deck">Baralho</option>
            </select>

            <label htmlFor={`trilha-material-de-${id}`} className="sr-only">
              {tipoDeMaterial === "page" ? `Anexar página como material de ${etapa.title}` : `Anexar baralho como material de ${etapa.title}`}
            </label>
            {tipoDeMaterial === "page" ? (
              <select
                id={`trilha-material-de-${id}`}
                value={paginaParaMaterial}
                onChange={(event) => setPaginaParaMaterial(event.currentTarget.value)}
                disabled={paginasParaAnexar.length === 0}
                className="w-32 rounded-sm border border-border bg-paper px-1 py-1 text-xs text-ink"
              >
                <option value="">{paginasParaAnexar.length === 0 ? "Nenhuma página" : "Anexar página…"}</option>
                {paginasParaAnexar.map((pagina) => (
                  <option key={pagina.id} value={pagina.id}>
                    {displayTitle(pagina)}
                  </option>
                ))}
              </select>
            ) : (
              <select
                id={`trilha-material-de-${id}`}
                value={deckParaMaterial}
                onChange={(event) => setDeckParaMaterial(event.currentTarget.value)}
                disabled={decksParaAnexar.length === 0}
                className="w-32 rounded-sm border border-border bg-paper px-1 py-1 text-xs text-ink"
              >
                <option value="">{decksParaAnexar.length === 0 ? "Nenhum baralho" : "Anexar baralho…"}</option>
                {decksParaAnexar.map((deck) => (
                  <option key={deck.id} value={deck.id}>
                    {deck.name}
                  </option>
                ))}
              </select>
            )}

            <button
              type="submit"
              disabled={tipoDeMaterial === "page" ? !paginaParaMaterial : !deckParaMaterial}
              className="shrink-0 rounded-sm bg-emerald px-2 py-1 text-xs font-medium text-on-emerald transition-transform duration-150 ease-out active:scale-97 disabled:opacity-50 motion-reduce:transition-none"
            >
              +
            </button>
          </form>
        </div>

        {/* Apagar etapa: reversível (vai para a lixeira de Notas, ver
            `removerEtapa` em lib/ipc.ts), mas a confirmação só entra em
            detalhe de cadeia quando há algo real a avisar — etapa comum, sem
            bloqueadora e sem quem bloqueia, não ganha um parágrafo a mais. */}
        {confirmandoApagar ? (
          <div role="alertdialog" aria-label={`Apagar ${etapa.title}?`} className="w-56 rounded-sm border border-border bg-surface p-2 shadow-hard-sm">
            <p className="text-xs text-ink">
              Apagar "{etapa.title}"? Vai para a lixeira de Notas — dá para restaurar depois, com progresso e materiais intactos.
            </p>
            {temCadeiaNosDoisLados ? (
              <p className="mt-1.5 text-xs text-ink">
                Esta etapa está no meio de uma cadeia: apagar remove a flecha que{" "}
                {bloqueadoras.length === 1 ? `"${bloqueadoras[0].title}" usa` : `${bloqueadoras.map((b) => `"${b.title}"`).join(", ")} usam`}{" "}
                para bloquear esta etapa, e a que esta etapa usa para bloquear{" "}
                {dependentes.length === 1 ? `"${dependentes[0].title}"` : dependentes.map((d) => `"${d.title}"`).join(", ")}.{" "}
                {dependentes.length === 1 ? "Ela" : "Elas"} NÃO {dependentes.length === 1 ? "passa" : "passam"} a ser bloqueada
                {dependentes.length === 1 ? "" : "s"} por{" "}
                {bloqueadoras.length === 1 ? `"${bloqueadoras[0].title}"` : "essas bloqueadoras"} no lugar — os dois lados não ficam ligados
                entre si.
                {dependentesQueFicamSemBloqueadora.length > 0
                  ? ` ${dependentesQueFicamSemBloqueadora.length === 1 ? `"${dependentesQueFicamSemBloqueadora[0].title}" fica` : `${dependentesQueFicamSemBloqueadora.map((d) => `"${d.title}"`).join(", ")} ficam`} sem nenhuma bloqueadora — desbloqueada${dependentesQueFicamSemBloqueadora.length === 1 ? "" : "s"}.`
                  : ""}
              </p>
            ) : null}
            <div className="mt-1.5 flex gap-1">
              <button
                type="button"
                onClick={handleApagar}
                className="rounded-sm border border-terracotta-ink px-2 py-1 text-xs font-medium text-terracotta-ink transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
              >
                Apagar mesmo assim
              </button>
              <button
                type="button"
                onClick={() => setConfirmandoApagar(false)}
                className="rounded-sm border border-border px-2 py-1 text-xs text-ink-muted transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmandoApagar(true)}
            className="rounded-sm border border-border bg-surface px-2 py-1 text-xs font-medium text-terracotta-ink shadow-hard-sm transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
          >
            Apagar etapa
          </button>
        )}
      </NodeToolbar>

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      {/* Selos: texto + forma (borda pontilhada nos dois "em suspenso"), nunca
          só cor — a mesma informação já está em `data-situacao-no-caminho`
          e no `aria-label` do nó (`descricaoParaLeitorDeTela`). */}
      {ehDecisao || marco || classeDaSituacao ? (
        <div className="mb-1 flex flex-wrap items-center gap-1">
          {ehDecisao ? <span className="trilha-etapa__selo trilha-etapa__selo--decisao">Decisão</span> : null}
          {marco ? <span className="trilha-etapa__selo trilha-etapa__selo--marco">Marco</span> : null}
          {situacao === "aguardandoEscolha" ? (
            <span className="trilha-etapa__selo trilha-etapa__selo--aguardando">Aguardando escolha</span>
          ) : null}
          {situacao === "descartado" ? <span className="trilha-etapa__selo trilha-etapa__selo--descartada">Descartada</span> : null}
        </div>
      ) : null}

      {renomeandoTitulo ? (
        <input
          ref={tituloInputRef}
          value={rascunhoTitulo}
          onChange={(event) => setRascunhoTitulo(event.currentTarget.value)}
          onBlur={() => void confirmarRenomeacaoDoTitulo()}
          onKeyDown={handleKeyDownDoTitulo}
          aria-label={`Nome da etapa ${etapa.title}`}
          className="nodrag trilha-etapa__titulo w-full rounded-sm border border-border bg-paper px-1 py-0.5"
        />
      ) : (
        <button
          type="button"
          onDoubleClick={iniciarRenomeacaoDoTitulo}
          className="nodrag trilha-etapa__titulo w-full bg-transparent px-0 text-left"
          title="Duplo clique para renomear"
        >
          {etapa.title}
        </button>
      )}
      <p className="trilha-etapa__meta">
        {textoDeMeta(
          estado,
          bloqueadorasNaoConcluidas(etapa, todasEtapas, todasFlechas).map((bloqueadora) => bloqueadora.title),
        )}
      </p>

      {/* A frase que diz O QUÊ está em suspenso/descartado — os selos acima
          só apontam a categoria, esta linha nomeia a decisão e, no caso mais
          delicado (item 3 do pedido), garante que o progresso não sumiu. */}
      {situacao !== "ativo" ? (
        <p className="trilha-etapa__situacao">
          {situacao === "aguardandoEscolha"
            ? `Em suspenso${decisoesPendentes.length > 0 ? ` — esperando a escolha de ${decisoesPendentes.map((decisao) => decisao.title).join(", ")}` : ""}.`
            : `Caminho descartado${caminhosDescartados.length > 0 ? ` — ${caminhosDescartados[0].decisao.title} escolheu "${caminhosDescartados[0].escolhido}"` : ""}.${
                etapa.state !== null ? " O progresso desta etapa continua salvo." : ""
              }`}
        </p>
      ) : null}
    </div>
  );
}

export const EtapaNode = memo(EtapaNodeComponent);
