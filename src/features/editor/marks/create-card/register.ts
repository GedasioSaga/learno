/**
 * "Criar cartão" a partir de um trecho selecionado — um botão a mais na
 * barra de seleção de texto que `marks/basic/` já registra, mais o
 * formulário que ele abre (`registerEditorOverlay`). Nenhuma marca nem nó
 * novo: a ação só LÊ a seleção e o bloco atual, nunca muda o documento —
 * por isso não há `registerBlockExtension` aqui, diferente de todo outro
 * `register.ts` deste pacote. Descoberto automaticamente por
 * `core/discover-extensions.ts`; ninguém importa este arquivo diretamente.
 */
import { createElement } from "react";
import { registerEditorOverlay, registerFormattingMenuItem } from "../../core/block-spec";
import { renderCreateCardButton } from "./CreateCardButton";
import { CreateCardOverlay } from "./CreateCardOverlay";
import { renderCreateClozeButton } from "./CreateClozeButton";

registerFormattingMenuItem({ id: "cartoes:criar-cartao", order: 10, render: renderCreateCardButton });
registerFormattingMenuItem({ id: "cartoes:criar-lacuna", order: 11, render: renderCreateClozeButton });

registerEditorOverlay({
  id: "cartoes:criar-cartao-overlay",
  render: () => createElement(CreateCardOverlay),
});
