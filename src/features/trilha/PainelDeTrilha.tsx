import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { TrilhaResumo } from "../../lib/ipc";
import { useTrilhaStore } from "./store";

interface LinhaDaTrilhaProps {
  resumo: TrilhaResumo;
  ativa: boolean;
}

/**
 * Uma linha da lista de trilhas — mesmo padrão de renomeação inline de
 * `LinhaDoMapa` (`features/mapa-mental/PainelDeMapaMental.tsx`): duplo
 * clique entra, Enter confirma via blur, Escape cancela. `renomearTrilha`
 * edita `database` + `view` + a página-container juntos (o trio que nasce
 * com o mesmo nome — ver o comentário dela em `store.ts`), então esta linha
 * não precisa saber que são três comandos por baixo.
 */
function LinhaDaTrilha({ resumo, ativa }: LinhaDaTrilhaProps) {
  const selecionarTrilha = useTrilhaStore((state) => state.selecionarTrilha);
  const renomearTrilha = useTrilhaStore((state) => state.renomearTrilha);
  const apagarTrilha = useTrilhaStore((state) => state.apagarTrilha);
  const pendingRenameId = useTrilhaStore((state) => state.pendingRenameId);
  const consumePendingRename = useTrilhaStore((state) => state.consumePendingRename);

  const [renomeando, setRenomeando] = useState(false);
  const [rascunho, setRascunho] = useState(resumo.nome);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renomeando) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renomeando]);

  function iniciarRenomeacao() {
    setRascunho(resumo.nome);
    setRenomeando(true);
  }

  // A trilha nasce pelo "+ Nova trilha" já em modo de edição de nome — mesmo
  // papel de `pendingFocusId` em `PageTreeItem`/`pendingRenameId` do mapa
  // mental. `iniciarRenomeacao`/`consumePendingRename` ficam fora da lista de
  // dependências de propósito: não mudam de comportamento entre renders, e
  // incluí-las dispararia o efeito de novo sem nenhuma mudança real de
  // estado para reagir.
  useEffect(() => {
    if (pendingRenameId === resumo.viewId) {
      iniciarRenomeacao();
      consumePendingRename(resumo.viewId);
    }
  }, [pendingRenameId, resumo.viewId]);

  async function confirmarRenomeacao() {
    setRenomeando(false);
    const nome = rascunho.trim();
    if (!nome || nome === resumo.nome) return;
    await renomearTrilha(resumo.viewId, resumo.databaseId, resumo.containerPageId, nome);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      setRenomeando(false);
      setRascunho(resumo.nome);
    }
  }

  async function handleApagar() {
    // Irreversível aos olhos do usuário (some da lista), mas por baixo é
    // `trashPage` — a lixeira de Notas ainda tem a página, com o database e
    // a view dentro dela.
    const confirmado = window.confirm(`Apagar a trilha "${resumo.nome}"? A página dela vai para a lixeira de Notas.`);
    if (!confirmado) return;
    await apagarTrilha(resumo.viewId, resumo.containerPageId);
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
          aria-label={`Nome de ${resumo.nome}`}
          className="min-w-0 flex-1 rounded-sm border border-border bg-paper px-2 py-1 text-sm text-ink"
        />
      ) : (
        <button
          type="button"
          onClick={() => void selecionarTrilha(resumo.viewId)}
          onDoubleClick={iniciarRenomeacao}
          aria-current={ativa ? "true" : undefined}
          className={`min-w-0 flex-1 truncate rounded-sm px-2 py-1 text-left text-sm
            ${ativa ? "bg-surface-raised text-ink" : "text-ink hover:bg-surface-raised/60"}`}
        >
          {resumo.nome}
        </button>
      )}

      <button
        type="button"
        onClick={() => void handleApagar()}
        aria-label={`Apagar ${resumo.nome}`}
        className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted opacity-0
          transition-opacity hover:bg-surface hover:text-terracotta-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        🗑
      </button>
    </li>
  );
}

/**
 * A lista de trilhas — implementa `ImplementacaoDaSecao.Painel` (ver
 * `features/navegacao/contrato.ts`). Sem props: a trilha ativa mora em
 * `useTrilhaStore`, é assim que este painel e `ConteudoDeTrilha` conversam
 * sem passar pela casca — mesmo desenho de `PainelDeMapaMental`.
 *
 * Carrega a LISTA por conta própria (`carregarTrilhas`), independente de
 * `ConteudoDeTrilha` carregar a trilha ATIVA (`carregar`): item 1 do pedido —
 * "criar várias, listar, trocar" — precisa da lista mesmo quando o conteúdo
 * está em erro, ou quando ainda não há nenhuma trilha ativa.
 */
export function PainelDeTrilha() {
  const listaStatus = useTrilhaStore((state) => state.listaStatus);
  const errorMessage = useTrilhaStore((state) => state.errorMessage);
  const trilhas = useTrilhaStore((state) => state.trilhas);
  const viewIdAtivo = useTrilhaStore((state) => state.viewId);
  const carregarTrilhas = useTrilhaStore((state) => state.carregarTrilhas);
  const criarNovaTrilha = useTrilhaStore((state) => state.criarNovaTrilha);
  const criandoTrilha = useTrilhaStore((state) => state.criandoTrilha);

  useEffect(() => {
    void carregarTrilhas();
  }, [carregarTrilhas]);

  if (listaStatus === "loading" || listaStatus === "idle") {
    return <p className="px-4 py-3 text-sm text-ink-muted">Carregando trilhas…</p>;
  }

  if (listaStatus === "error") {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-terracotta-ink">
        {errorMessage ?? "Não foi possível carregar as trilhas."}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col py-2">
      {trilhas.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-muted">Nenhuma trilha ainda.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
          {trilhas.map((resumo) => (
            <LinhaDaTrilha key={resumo.viewId} resumo={resumo} ativa={resumo.viewId === viewIdAtivo} />
          ))}
        </ul>
      )}

      {/* Erro sem destino: `renomearTrilha`/`apagarTrilha`/`criarNovaTrilha`
          já escreviam `errorMessage` na falha, mas nenhuma tela fora do
          carregamento inicial (`listaStatus === "error"`, acima) o lia — a
          falha morria calada. Isto é o destino que faltava. */}
      {errorMessage && (
        <p role="alert" className="px-4 py-1.5 text-xs text-terracotta-ink">
          {errorMessage}
        </p>
      )}

      <div className="border-t border-border px-2 pt-2">
        <button
          type="button"
          disabled={criandoTrilha}
          onClick={() => {
            // `.catch` explícito, não `void`: `criarNovaTrilha` já grava o
            // erro em `errorMessage` (mostrado acima) antes de rejeitar —
            // sem isto a rejeição fica sem handler e vira "Unhandled
            // Rejection" no console/nos testes, mesmo com o erro já tratado
            // de verdade (mesmo cuidado de `PainelDeMapaMental`).
            criarNovaTrilha("Trilha").catch(() => {});
          }}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-muted
            transition-transform hover:bg-surface-sunken/60 hover:text-ink active:scale-97 disabled:opacity-50"
        >
          <span aria-hidden="true">+</span> {criandoTrilha ? "Criando…" : "Nova trilha"}
        </button>
      </div>
    </div>
  );
}
