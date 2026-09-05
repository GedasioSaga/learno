/**
 * Ponto de registro do menu "/" (EDT-047): a extensão que decide QUANDO o
 * menu está ativo (`slash-menu-extension.ts`) e o overlay que decide O QUE
 * aparece na tela (`SlashMenuOverlay.tsx`) - dois registros porque são dois
 * pontos de extensão diferentes do `core/block-spec.ts` (itens 1 e 5 do
 * README), não porque este builder tem dois recursos.
 *
 * `createElement` em vez de JSX: `discover-extensions.ts` só descobre
 * arquivos chamados exatamente `register.ts` (glob literal), então este
 * arquivo não pode ser `.tsx`.
 */
import { createElement } from "react";
import { registerEditorOverlay } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import { SlashMenuExtension } from "./slash-menu-extension";
import { SlashMenuOverlay } from "./SlashMenuOverlay";

registerBlockExtension(SlashMenuExtension);

registerEditorOverlay({
  id: "interaction:slash-menu",
  render: (editor) => createElement(SlashMenuOverlay, { editor }),
});
