import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import { useTrilhaStore } from "./store";
import type { NoDeRaia } from "./tipos-do-canvas";

/**
 * A faixa horizontal de uma raia. `pointer-events: none` vem de
 * `.trilha-raia` (trilha.css) — só o cabeçalho (`.trilha-raia__cabecalho`)
 * reabre eventos, e é por isso que o botão de recolher funciona mesmo com a
 * faixa inteira "atravessável" pelo mouse (as etapas, que são outros nós,
 * ficam por cima dela de qualquer forma).
 *
 * Renomear/reordenar só aparecem para uma raia NOMEADA (`laneValue` não
 * vazio) — a raia única sem título (TRL-014) é sintética (`viewId === ""`,
 * ver `ordenarRaiasParaExibicao` em `layout.ts`): não há `trail_lanes` por
 * trás dela para `renomear_raia`/`reordenar_raia` mexerem.
 */
function RaiaNodeComponent({ data }: NodeProps<NoDeRaia>) {
  const { raia, cor, totalEtapas, concluidas } = data;
  const definirRaiaRecolhida = useTrilhaStore((state) => state.definirRaiaRecolhida);
  const renomearRaia = useTrilhaStore((state) => state.renomearRaia);
  const reordenarRaia = useTrilhaStore((state) => state.reordenarRaia);
  const apagarRaia = useTrilhaStore((state) => state.apagarRaia);
  const raias = useTrilhaStore((state) => state.trilha?.raias ?? []);

  const [renomeando, setRenomeando] = useState(false);
  const [rascunho, setRascunho] = useState(raia.laneValue);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Confirmação inline de apagar — nunca `window.confirm` (trava a WebView do Tauri), mesmo padrão do resto do produto. */
  const [confirmandoApagar, setConfirmandoApagar] = useState(false);

  const titulo = raia.laneValue.trim().length > 0 ? raia.laneValue : "Sem raia";
  const ehNomeada = raia.laneValue.trim().length > 0;
  const indice = raias.findIndex((item) => item.laneValue === raia.laneValue);

  useEffect(() => {
    if (renomeando) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renomeando]);

  async function confirmarRenomeacao() {
    setRenomeando(false);
    const novoValor = rascunho.trim();
    if (!novoValor || novoValor === raia.laneValue) return;
    await renomearRaia(raia.laneValue, novoValor);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setRenomeando(false);
      setRascunho(raia.laneValue);
    }
  }

  // "Subir" põe a raia logo depois de quem hoje está DUAS posições acima
  // (pulando a vizinha imediata, que é justamente com quem ela troca de
  // lugar); `null` significa "primeira da lista" — mesma convenção de
  // `reordenarRaia`/`aposLaneValue`.
  const aposValorParaSubir = indice >= 2 ? raias[indice - 2].laneValue : null;
  const aposValorParaDescer = indice >= 0 && indice + 1 < raias.length ? raias[indice + 1].laneValue : undefined;

  function handleApagar() {
    setConfirmandoApagar(false);
    void apagarRaia(raia.laneValue);
  }

  return (
    <div className={["trilha-raia", cor ? `trilha-cor--${cor}` : null, raia.isCollapsed ? "trilha-raia--recolhida" : null].filter(Boolean).join(" ")}>
      <div className="trilha-raia__cabecalho group">
        <button
          type="button"
          className="trilha-raia__alternar"
          aria-expanded={!raia.isCollapsed}
          aria-label={raia.isCollapsed ? `Expandir a raia ${titulo}` : `Recolher a raia ${titulo}`}
          onClick={() => void definirRaiaRecolhida(raia.laneValue, !raia.isCollapsed)}
        />

        {renomeando ? (
          <input
            ref={inputRef}
            value={rascunho}
            onChange={(event) => setRascunho(event.currentTarget.value)}
            onBlur={() => void confirmarRenomeacao()}
            onKeyDown={handleKeyDown}
            aria-label={`Nome da raia ${titulo}`}
            className="nodrag min-w-0 max-w-40 rounded-sm border border-border bg-paper px-1.5 py-0.5 text-sm text-ink"
          />
        ) : ehNomeada ? (
          <button
            type="button"
            onDoubleClick={() => {
              setRascunho(raia.laneValue);
              setRenomeando(true);
            }}
            className="trilha-raia__titulo max-w-40 truncate bg-transparent px-0 text-left"
            title="Duplo clique para renomear"
          >
            {titulo}
          </button>
        ) : (
          <p className="trilha-raia__titulo">{titulo}</p>
        )}

        {ehNomeada && raias.length > 1 ? (
          <div className="flex shrink-0 gap-0.5">
            <button
              type="button"
              disabled={aposValorParaSubir === null && indice === 0}
              onClick={() => void reordenarRaia(raia.laneValue, aposValorParaSubir)}
              aria-label={`Mover a raia ${titulo} para cima`}
              className="grid size-5 place-items-center rounded-sm text-xs text-ink-muted hover:bg-surface-raised hover:text-ink disabled:opacity-30"
            >
              ▲
            </button>
            <button
              type="button"
              disabled={aposValorParaDescer === undefined}
              onClick={() => aposValorParaDescer !== undefined && void reordenarRaia(raia.laneValue, aposValorParaDescer)}
              aria-label={`Mover a raia ${titulo} para baixo`}
              className="grid size-5 place-items-center rounded-sm text-xs text-ink-muted hover:bg-surface-raised hover:text-ink disabled:opacity-30"
            >
              ▼
            </button>
          </div>
        ) : null}

        {/* Apagar raia: só existe para raia NOMEADA, pelo mesmo motivo de
            renomear/reordenar (a raia única sem título é sintética, sem
            `trail_lanes` por trás). NUNCA apaga etapa (TRL-014) — a
            confirmação diz quantas vão para "Sem raia" antes de escrever. */}
        {ehNomeada ? (
          <>
            {/* Ação destrutiva não mora em repouso na tela (mesmo critério da
                Biblioteca, `LivroCard.tsx`): invisível até hover/foco do
                cabeçalho, mas sempre alcançável por teclado
                (`group-focus-within`/`focus-visible`, não só `group-hover`). */}
            <button
              type="button"
              onClick={() => setConfirmandoApagar(true)}
              aria-label={`Apagar a raia ${titulo}`}
              title="Apagar raia"
              className="grid size-5 shrink-0 place-items-center rounded-sm text-xs text-ink-muted opacity-0 transition-opacity
                hover:bg-surface-raised hover:text-terracotta-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              🗑
            </button>

            {/* `NodeToolbar`, não uma `<div absolute>` própria: as raias e as
                etapas são nós IRMÃOS do mesmo canvas (`tipos-do-canvas.ts`),
                cada `transform` cria seu próprio contexto de empilhamento, e
                um `z-index` interno à raia não consegue subir acima de um nó
                de etapa vizinho que por acaso ocupa o mesmo pedaço de tela —
                foi exatamente o que aconteceu na vitrine: a confirmação
                nascia atrás do cartão de etapa embaixo e ficava inclicável.
                `NodeToolbar` resolve isso porque é um portal do próprio
                `@xyflow/react`, o mesmo mecanismo que `EtapaNode` já usa para
                a barra de ações dele — sempre acima de qualquer nó. */}
            <NodeToolbar isVisible={confirmandoApagar} position={Position.Bottom} align="start" className="nodrag">
              <div role="alertdialog" aria-label={`Apagar a raia ${titulo}?`} className="w-60 rounded-sm border border-border bg-surface p-2 shadow-hard-sm">
                <p className="text-xs text-ink">
                  {totalEtapas === 0
                    ? `Apagar a raia "${titulo}"? Ela está vazia.`
                    : `Apagar a raia "${titulo}"? ${totalEtapas} etapa${totalEtapas === 1 ? "" : "s"} ${
                        totalEtapas === 1 ? "vai" : "vão"
                      } para "Sem raia" — ${totalEtapas === 1 ? "ela não é apagada" : "elas não são apagadas"}.`}
                </p>
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
                    autoFocus
                    onClick={() => setConfirmandoApagar(false)}
                    className="rounded-sm border border-border px-2 py-1 text-xs text-ink-muted transition-transform duration-150 ease-out active:scale-97 motion-reduce:transition-none"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </NodeToolbar>
          </>
        ) : null}

        <p className="trilha-raia__resumo">
          {totalEtapas} etapa{totalEtapas === 1 ? "" : "s"} · {concluidas} concluída{concluidas === 1 ? "" : "s"}
        </p>
      </div>
      <div className="trilha-raia__corpo" />
    </div>
  );
}

export const RaiaNode = memo(RaiaNodeComponent);
