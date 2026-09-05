/**
 * FUN-044: rodapé "Backlinks" de uma página — todo bloco, em qualquer outra
 * página ativa, que a menciona ou linka, navegável até a página de origem.
 * Sem nenhuma entrada, não renderiza seção alguma — nunca um cabeçalho
 * "Backlinks" vazio (ver `BacklinksSection.test.tsx`).
 */
import { useEffect, useState } from "react";
import { usePageTreeStore } from "../store";
import { whenBlockWritesSettle } from "../../editor";
import { listBacklinks, type BacklinkRow } from "./ipc";
import { usePageTitle } from "./use-page-title";

interface BacklinkEntry {
  sourceBlockId: string;
  sourcePageId: string;
  /** Título no momento da consulta — `BacklinksSectionItem` não confia nele sozinho, ver seu comentário. */
  sourcePageTitle: string;
  snippet: string;
}

/**
 * `list_backlinks` (FUN-044) já devolve o trecho pronto —
 * `BacklinkRow.sourceSnippet` (`db::backlinks::BacklinkRow`,
 * `src-tauri/src/db/backlinks.rs`) é cortado e limitado no servidor, por
 * caractere e em fronteira de palavra. Nenhum round trip extra a
 * `blocksApi.list_page_blocks` é necessário aqui.
 */
function toEntries(rows: BacklinkRow[]): BacklinkEntry[] {
  return rows.map((row) => ({
    sourceBlockId: row.sourceBlockId,
    sourcePageId: row.sourcePageId,
    sourcePageTitle: row.sourcePageTitle,
    snippet: row.sourceSnippet,
  }));
}

interface BacklinksSectionProps {
  pageId: string;
}

export function BacklinksSection({ pageId }: BacklinksSectionProps) {
  const [entries, setEntries] = useState<BacklinkEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    // Espera o autosave da página ANTERIOR chegar ao banco antes de perguntar
    // quem menciona esta. Sair de uma página dispara o flush dela pela
    // limpeza de efeito do editor, que o React não deixa ser `async` — a
    // escrita sai sem ninguém esperando (ver `whenBlockWritesSettle`). Sem
    // esta barreira, mencionar uma página e abri-la em seguida mostrava um
    // backlink de menos, e a busca só roda uma vez por página montada, então
    // o número errado ficava na tela até recarregar.
    whenBlockWritesSettle()
      .then(() => listBacklinks(pageId))
      .then(toEntries)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        // Um rodapé que não carrega não deve travar a página inteira (o
        // editor acima continua funcionando) — mesmo raciocínio do estado
        // vazio, só que para erro: nada de "Backlinks" com um aviso de falha
        // permanente ocupando espaço embaixo de toda nota.
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (!entries || entries.length === 0) return null;

  const count = entries.length;
  const countLabel = count === 1 ? "1 backlink" : `${count} backlinks`;

  return (
    <section aria-label="Backlinks" className="mt-10 border-t border-border pt-4">
      <h2 className="font-display text-sm font-semibold text-ink">Backlinks</h2>
      <p className="mt-0.5 text-xs text-ink-muted">{countLabel}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {entries.map((entry) => (
          <li key={entry.sourceBlockId}>
            <BacklinkItem entry={entry} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Título lido de `usePageTitle` (reativo pelo id, FUN-045), não da cópia que
 * `entry.sourcePageTitle` carrega — a mesma consulta que popula essa cópia
 * fica desatualizada assim que a página de origem é renomeada enquanto este
 * rodapé continua montado, exatamente o problema que FUN-045 pede para
 * fechar. `entry.sourcePageTitle` só serve de `fallback`: uma página que a
 * store ainda não carregou continua com o título que o backend já devolveu,
 * em vez de cair no genérico "Sem título" à toa.
 */
function BacklinkItem({ entry }: { entry: BacklinkEntry }) {
  const selectPage = usePageTreeStore((state) => state.selectPage);
  const title = usePageTitle(entry.sourcePageId, entry.sourcePageTitle);

  return (
    <button
      type="button"
      onClick={() => selectPage(entry.sourcePageId)}
      className="flex w-full flex-col items-start gap-0.5 rounded-sm border border-border bg-surface px-3 py-2 text-left
        text-sm shadow-hard-sm transition-transform hover:-translate-y-px active:translate-y-0 active:shadow-none"
    >
      <span className="font-medium text-ink">{title}</span>
      {entry.snippet ? <span className="text-xs text-ink-muted">{entry.snippet}</span> : null}
    </button>
  );
}
