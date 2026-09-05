/**
 * EDT-043: abre a URL de um link clicado no navegador padrão do SO dentro do
 * Tauri, e numa aba normal fora dele - mesmo padrão já estabelecido em
 * `blocks/bookmark/open-url.ts` para o mesmo problema (abrir uma URL a
 * partir de dentro do editor). Sem isso, o clique cairia no comportamento
 * padrão de `@tiptap/extension-link` (`openOnClick: true`), que chama
 * `window.open` cru - num app Tauri v2 isso normalmente abre uma janela
 * nativa crua do próprio app em vez do navegador do SO. Por isso
 * `register.ts` desliga `openOnClick` e `LinkClickHandler.tsx` chama esta
 * função no lugar.
 *
 * Revalida com `parseLinkUrl` mesmo o `href` já ter passado pelo popup ou
 * pelo `isAllowedUri` da extensão ao ser criado - mesma defesa em
 * profundidade de `open-url.ts` ("hostile or malformed scheme - never hand
 * this to the OS opener or window.open"), porque um `href` também pode vir
 * de um documento carregado do banco, um caminho que não passa pelo popup.
 */
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { parseLinkUrl } from "./link-url";

export async function openLinkUrl(href: string): Promise<void> {
  const safe = parseLinkUrl(href);
  if (!safe) return;
  if (isTauri()) {
    await openUrl(safe);
    return;
  }
  window.open(safe, "_blank", "noopener,noreferrer");
}
