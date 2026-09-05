/**
 * EDT-082: sobrescrito e subscrito, mutuamente exclusivos sobre o mesmo
 * trecho de texto - aplicar um tem que tirar o outro do trecho, nunca os
 * dois ao mesmo tempo.
 *
 * A exclusão via `excludes` (propriedade nativa de `MarkSpec` do
 * ProseMirror, aceita como chave de config em `Mark.create`/`.extend`)
 * precisa ser declarada nos DOIS lados. `Mark.addToSet` (prosemirror-model)
 * decide assim ao aplicar uma marca nova sobre um conjunto existente: se
 * `novaMarca.type.excludes(outra.type)` for verdadeiro, `outra` é removida e
 * `novaMarca` entra; senão, se `outra.type.excludes(novaMarca.type)` for
 * verdadeiro, `novaMarca` é recusada por inteiro e o conjunto fica como
 * estava. Só sobrescrito declarando exclusão contra subscrito cobriria a
 * direção sobrescrito-por-cima-de-subscrito; a direção contrária cairia no
 * segundo ramo e bloquearia a aplicação de subscrito em vez de substituir -
 * daí os dois lados precisarem da mesma declaração.
 */
import { createElement } from "react";
import { Subscript as SubscriptBase } from "@tiptap/extension-subscript";
import { Superscript as SuperscriptBase } from "@tiptap/extension-superscript";
import { registerFormattingMenuItem } from "../../core/block-spec";
import { registerBlockExtension } from "../../core/registry";
import { SubscriptButton, SuperscriptButton } from "./FormattingButtons";
import "./script.css";

export const Subscript = SubscriptBase.extend({ excludes: "superscript" });
export const Superscript = SuperscriptBase.extend({ excludes: "subscript" });

registerBlockExtension([Superscript, Subscript]);

registerFormattingMenuItem({
  id: "marks:superscript",
  order: 60,
  render: (editor) => createElement(SuperscriptButton, { editor }),
});

registerFormattingMenuItem({
  id: "marks:subscript",
  order: 61,
  render: (editor) => createElement(SubscriptButton, { editor }),
});
