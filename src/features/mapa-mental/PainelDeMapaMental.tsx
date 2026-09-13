import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { MindmapRow } from "../../lib/ipc";
import { useMapaMentalStore } from "./store";

interface LinhaDoMapaProps {
  mapa: MindmapRow;
  selecionado: boolean;
}

/**
 * Uma linha da lista de mapas — mesmo padrão de renomeação inline de
 * `PageTreeItem` (duplo clique entra, Enter confirma via blur, Escape
 * cancela), só que sem árvore: `mindmaps` não tem `parent_id`, é uma lista
 * plana.
 */
function LinhaDoMapa({ mapa, selecionado }: LinhaDoMapaProps) {
  const selecionarMapa = useMapaMentalStore((state) => state.selecionarMapa);
  const renomearMapa = useMapaMentalStore((state) => state.renomearMapa);
  const apagarMapa = useMapaMentalStore((state) => state.apagarMapa);
  const pendingRenameId = useMapaMentalStore((state) => state.pendingRenameId);
  const consumePendingRename = useMapaMentalStore((state) => state.consumePendingRename);

  const [renomeando, setRenomeando] = useState(false);
  const [rascunho, setRascunho] = useState(mapa.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renomeando) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renomeando]);

  function iniciarRenomeacao() {
    setRascunho(mapa.name);
    setRenomeando(true);
  }

  // O mapa nasce pelo "+ Novo mapa" já em modo de edição de nome — mesmo
  // papel de `pendingFocusId` em `PageTreeItem`. `iniciarRenomeacao` e
  // `consumePendingRename` ficam fora da lista de dependências de propósito:
  // não mudam de comportamento entre renders, e incluí-las dispararia o
  // efeito de novo sem nenhuma mudança real de estado para reagir.
  useEffect(() => {
    if (pendingRenameId === mapa.id) {
      iniciarRenomeacao();
      consumePendingRename(mapa.id);
    }
  }, [pendingRenameId, mapa.id]);

  async function confirmarRenomeacao() {
    setRenomeando(false);
    const nome = rascunho.trim();
    if (!nome || nome === mapa.name) return;
    await renomearMapa(mapa.id, nome);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setRenomeando(false);
      setRascunho(mapa.name);
    }
  }

  async function handleApagar() {
    // Irreversível — mesma confirmação nativa que `TrashDialog` usa para
    // excluir permanentemente, sem lib extra de diálogo.
    const confirmado = window.confirm(`Apagar o mapa mental "${mapa.name}"? Isto não pode ser desfeito.`);
    if (!confirmado) return;
    await apagarMapa(mapa.id);
  }

  return (
    <li className="group flex items-center gap-1">
      {renomeando ? (
        <input
          ref={inputRef}
          value={rascunho}
          onChange={(event) => setRascunho(event.currentTarget.value)}
          onBlur={() => void confirmarRenomeacao()}
          onKeyDown={handleKeyDown}
          aria-label={`Nome de ${mapa.name}`}
          className="min-w-0 flex-1 rounded-sm border border-border bg-paper px-2 py-1 text-sm text-ink"
        />
      ) : (
        <button
          type="button"
          onClick={() => void selecionarMapa(mapa.id)}
          onDoubleClick={iniciarRenomeacao}
          aria-current={selecionado ? "true" : undefined}
          className={`min-w-0 flex-1 truncate rounded-sm px-2 py-1 text-left text-sm
            ${selecionado ? "bg-surface-raised text-ink" : "text-ink hover:bg-surface-raised/60"}`}
        >
          {mapa.name}
        </button>
      )}

      <button
        type="button"
        onClick={() => void handleApagar()}
        aria-label={`Apagar ${mapa.name}`}
        className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted opacity-0
          transition-opacity hover:bg-surface hover:text-terracotta-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        🗑
      </button>
    </li>
  );
}

/**
 * A lista de mapas mentais — implementa `ImplementacaoDaSecao.Painel` (ver
 * `features/navegacao/contrato.ts`). Sem props: o mapa ativo mora em
 * `useMapaMentalStore`, e é assim que este painel e `ConteudoDeMapaMental`
 * conversam sem passar pela casca.
 */
export function PainelDeMapaMental() {
  const statusLista = useMapaMentalStore((state) => state.statusLista);
  const errorMessage = useMapaMentalStore((state) => state.errorMessage);
  const mapas = useMapaMentalStore((state) => state.mapas);
  const mapaAtivoId = useMapaMentalStore((state) => state.mapaAtivoId);
  const carregarMapas = useMapaMentalStore((state) => state.carregarMapas);
  const criarMapa = useMapaMentalStore((state) => state.criarMapa);

  useEffect(() => {
    void carregarMapas();
  }, [carregarMapas]);

  if (statusLista === "loading" || statusLista === "idle") {
    return <p className="px-4 py-3 text-sm text-ink-muted">Carregando mapas…</p>;
  }

  if (statusLista === "error") {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar os mapas mentais."}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col py-2">
      {mapas.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-muted">Nenhum mapa mental ainda.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
          {mapas.map((mapa) => (
            <LinhaDoMapa key={mapa.id} mapa={mapa} selecionado={mapa.id === mapaAtivoId} />
          ))}
        </ul>
      )}

      {/* Erro sem destino: `criarMapa`/`renomearMapa`/`apagarMapa` já
          escreviam `errorMessage` na falha, mas nenhuma tela fora do
          carregamento inicial (`statusLista === "error"`, acima) o lia — a
          falha morria calada. Isto é o destino que faltava. */}
      {errorMessage && (
        <p role="alert" className="px-4 py-1.5 text-xs text-terracotta-ink">
          {errorMessage}
        </p>
      )}

      <div className="border-t border-border px-2 pt-2">
        <button
          type="button"
          onClick={() => {
            // `.catch` explícito, não `void`: `criarMapa` já grava o erro em
            // `errorMessage` (mostrado acima) antes de rejeitar — sem isto a
            // rejeição fica sem handler e vira "Unhandled Rejection" no
            // console/nos testes, mesmo com o erro já tratado de verdade.
            criarMapa("Novo mapa").catch(() => {});
          }}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-muted
            transition-transform hover:bg-surface-sunken/60 hover:text-ink active:scale-97"
        >
          <span aria-hidden="true">+</span> Novo mapa
        </button>
      </div>
    </div>
  );
}
