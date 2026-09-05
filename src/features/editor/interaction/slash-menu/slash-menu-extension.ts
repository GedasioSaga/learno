/**
 * Gatilho "/" do menu de barra (EDT-047). `@tiptap/suggestion` decide QUANDO
 * o menu deve estar ativo - o `allowedPrefixes` default do próprio pacote
 * (`[' ']`, ver `node_modules/@tiptap/suggestion/dist/index.js`) já é
 * exatamente a regra pedida: dispara com o "/" no começo do texto que
 * precede o cursor (bloco vazio) ou logo depois de um espaço, nunca no meio
 * de uma palavra. Não precisou de `allow`/`startOfLine` próprios por isso.
 *
 * Este arquivo só decide ONDE e SE o menu está ativo, e intercepta
 * Enter/setas antes que caiam no keymap estrutural do core (um Enter comum
 * divide o bloco - `core/commands.ts`'s `handleEnter` - que é errado com o
 * menu aberto). A renderização em si é o `EditorOverlay` registrado em
 * `register.ts`; este módulo só empurra estado pra `slash-menu-store.ts`.
 *
 * Esc fecha sozinho: `@tiptap/suggestion` trata a tecla Escape antes mesmo
 * de chamar `onKeyDown` (ver `createSuggestionProps.handleKeyDown` no
 * pacote) e despacha a saída, que dispara `onExit` abaixo - nada a fazer
 * aqui por Esc.
 */
import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion } from "@tiptap/suggestion";
import { collectSlashMenuItems } from "../../core/block-spec";
import { clearSlashQuery } from "../../core/commands";
import { filterSlashMenuItems } from "./slash-menu-filter";
import { useSlashMenuStore } from "./slash-menu-store";

/** Key própria, não a `SuggestionPluginKey` default do pacote - outro builder (menção, EDT-046) também usa `@tiptap/suggestion` e não pode colidir com esta. */
export const slashMenuPluginKey = new PluginKey("learno-slash-menu");

const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter"]);

export const SlashMenuExtension = Extension.create({
  name: "learnoSlashMenu",

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      Suggestion({
        editor,
        pluginKey: slashMenuPluginKey,
        char: "/",
        render: () => ({
          onStart: (props) => {
            useSlashMenuStore.getState().open(props.query, props.clientRect?.() ?? null);
          },
          onUpdate: (props) => {
            useSlashMenuStore.getState().update(props.query, props.clientRect?.() ?? null);
          },
          onExit: () => {
            useSlashMenuStore.getState().close();
          },
          onKeyDown: ({ event }) => {
            if (!NAVIGATION_KEYS.has(event.key)) return false;
            const { query, highlightedId } = useSlashMenuStore.getState();
            const visible = filterSlashMenuItems(collectSlashMenuItems(), query);

            if (event.key === "Enter") {
              // Sempre engolido enquanto o menu está aberto: deixar passar
              // splitaria o bloco com "/filtro" ainda como texto nele.
              event.preventDefault();
              const target = visible.find((item) => item.id === highlightedId) ?? visible[0];
              if (!target) return true; // nada casou - EDT-047 pede a mensagem, não uma inserção às cegas.
              clearSlashQuery(editor, query.length);
              target.run(editor);
              useSlashMenuStore.getState().close();
              return true;
            }

            if (visible.length === 0) return true;
            // Nada realçado ainda == realçado implícito é o primeiro item
            // (mesma leitura que `SlashMenuOverlay` faz) - tratar como -1
            // faria a primeira seta pra baixo "mover" pro próprio item 0.
            const currentIndex = highlightedId === null ? 0 : visible.findIndex((item) => item.id === highlightedId);
            const step = event.key === "ArrowDown" ? 1 : -1;
            const nextIndex = (currentIndex + step + visible.length) % visible.length;
            useSlashMenuStore.getState().setHighlightedId(visible[nextIndex].id);
            return true;
          },
        }),
      }),
    ];
  },
});
