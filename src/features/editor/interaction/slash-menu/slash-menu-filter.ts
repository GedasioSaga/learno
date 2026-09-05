/**
 * Filtro e agrupamento da lista do menu "/" (EDT-047) - puro, sem TipTap,
 * pra ser testável isoladamente e reusável tanto pela navegação por teclado
 * (`slash-menu-extension.ts`, fora de qualquer render) quanto pelo overlay
 * que desenha a lista (`SlashMenuOverlay.tsx`). Nenhum dos dois reimplementa
 * a regra - os dois chamam estas duas funções.
 */
import type { SlashMenuItem } from "../../core/block-spec";
import { normalizeForSearch } from "./normalize";

export interface SlashMenuGroup {
  name: string;
  items: SlashMenuItem[];
}

/** Rótulo do grupo de quem não declarou `group` - nunca some da lista por falta de seção. */
export const UNGROUPED_LABEL = "Outros";

/**
 * Casa o título ou qualquer keyword, sem distinguir acento nem maiúscula de
 * minúscula. Query vazia (menu recém-aberto, só o "/" digitado) não filtra
 * nada - é o estado "mostra tudo".
 */
export function filterSlashMenuItems(items: SlashMenuItem[], query: string): SlashMenuItem[] {
  const normalizedQuery = normalizeForSearch(query.trim());
  if (!normalizedQuery) return items;
  return items.filter((item) => {
    const haystacks = [item.title, ...(item.keywords ?? [])];
    return haystacks.some((text) => normalizeForSearch(text).includes(normalizedQuery));
  });
}

/**
 * Agrupa preservando a ordem de primeira aparição do grupo na lista recebida
 * (que já chega ordenada globalmente por `order` - ver `collectSlashMenuItems`
 * em `core/block-spec.ts`), e ordena dentro de cada grupo por `item.order`.
 */
export function groupSlashMenuItems(items: SlashMenuItem[]): SlashMenuGroup[] {
  const byGroup = new Map<string, SlashMenuItem[]>();
  for (const item of items) {
    const name = item.group ?? UNGROUPED_LABEL;
    const bucket = byGroup.get(name);
    if (bucket) bucket.push(item);
    else byGroup.set(name, [item]);
  }
  return [...byGroup.entries()].map(([name, groupItems]) => ({
    name,
    items: [...groupItems].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
  }));
}
