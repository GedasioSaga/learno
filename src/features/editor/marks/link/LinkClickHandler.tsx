/**
 * EDT-043: clicar num link abre a URL pelo caminho certo para um app
 * desktop, em vez do `window.open` cru que `@tiptap/extension-link` chama
 * por padrão (`openOnClick: true`) - num app Tauri v2 isso normalmente abre
 * uma janela nativa crua do próprio app em vez do navegador padrão do SO.
 * `register.ts` desliga `openOnClick` na configuração da extensão; este
 * overlay assume a interceptação do clique e delega a abertura de verdade a
 * `open-link-url.ts`, o mesmo padrão que `blocks/bookmark/open-url.ts` já
 * usa para o mesmo problema.
 *
 * Não checa `editor.view.editable` como o `clickHandler` original da
 * extensão faz - de propósito. Aquele guard deixa o clique cair no
 * comportamento nativo do `<a href>` quando o editor não é editável, o que
 * navegaria a própria WebView do app para fora dela; interceptar em
 * qualquer estado fecha essa brecha em vez de reproduzi-la.
 */
import type { Editor as TiptapEditor } from "@tiptap/core";
import { useEffect } from "react";
import { openLinkUrl } from "./open-link-url";

interface LinkClickHandlerProps {
  editor: TiptapEditor;
}

const PRIMARY_MOUSE_BUTTON = 0;

export function LinkClickHandler({ editor }: LinkClickHandlerProps) {
  useEffect(() => {
    const dom = editor.view.dom;

    function handleClick(event: MouseEvent) {
      if (event.button !== PRIMARY_MOUSE_BUTTON) return;
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest("a.ed-link");
      if (!link || !dom.contains(link)) return;
      const href = link.getAttribute("href");
      if (!href) return;
      // O clique nativo no `<a>` navegaria a própria WebView - impede isso
      // antes de delegar para o abridor de verdade (assíncrono, então não
      // pode ser o que decide se o evento é tratado).
      event.preventDefault();
      void openLinkUrl(href);
    }

    dom.addEventListener("click", handleClick);
    return () => dom.removeEventListener("click", handleClick);
  }, [editor]);

  return null;
}
