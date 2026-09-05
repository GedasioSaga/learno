/**
 * EDT-043: link inline via Ctrl/Cmd+K. Uma marca, não um bloco - nenhum
 * `BlockSpec` aqui, pelo mesmo motivo do `marks/color/register.ts`: os
 * atributos da marca viajam dentro de `content.inline`, que o
 * `serialize.ts` já round-tripa genericamente (ver README, "Marcas de
 * texto"). Descoberto automaticamente por `core/discover-extensions.ts`;
 * ninguém importa este arquivo diretamente.
 *
 * Mantido como `.ts` puro (sem JSX) para o glob literal `register.ts` de
 * `discover-extensions.ts` continuar batendo - a UI de verdade mora em
 * `LinkOverlay.tsx`, um arquivo `.tsx` de verdade que este só conecta via
 * `createElement`.
 */
import { createElement } from "react";
import Link from "@tiptap/extension-link";
import { registerBlockExtension } from "../../core/registry";
import { registerEditorOverlay } from "../../core/block-spec";
import { LinkOverlay } from "./LinkOverlay";
import { LinkClickHandler } from "./LinkClickHandler";
import "./link.css";

export const LinkMark = Link.configure({
  // Classe própria para estilizar em `link.css` em vez de `a[href]` cru -
  // mais previsível se algum outro nó vier a renderizar um `<a>` por conta
  // própria no futuro.
  HTMLAttributes: { class: "ed-link" },
  // Desligado de propósito: o `openOnClick` padrão chama `window.open` cru
  // (node_modules/@tiptap/extension-link/dist/index.js, `clickHandler`), que
  // num app Tauri v2 normalmente abre uma janela nativa crua do próprio app
  // em vez do navegador do SO. `LinkClickHandler` assume o clique e abre a
  // URL pelo mesmo padrão que `blocks/bookmark/open-url.ts` já usa.
  openOnClick: false,
});

registerBlockExtension(LinkMark);

registerEditorOverlay({
  id: "marks:link",
  render: (editor) => createElement(LinkOverlay, { editor }),
});

registerEditorOverlay({
  id: "marks:link-click",
  render: (editor) => createElement(LinkClickHandler, { editor }),
});
