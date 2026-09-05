/**
 * Os dois botões da barra de formatação para EDT-082. Ficam num `.tsx`
 * separado porque `register.ts` (glob do core, ver `discover-extensions.ts`)
 * precisa ser exatamente esse nome de arquivo, e `.ts` não aceita sintaxe
 * JSX - só `.tsx` aceita.
 */
import type { Editor } from "@tiptap/core";

interface ScriptButtonProps {
  editor: Editor;
}

export function SuperscriptButton({ editor }: ScriptButtonProps) {
  const isActive = editor.isActive("superscript");
  return (
    <button
      type="button"
      className="ed-script-btn"
      aria-pressed={isActive}
      aria-label="Sobrescrito"
      title="Sobrescrito (Ctrl+.)"
      onClick={() => editor.chain().focus().toggleSuperscript().run()}
    >
      x<sup>2</sup>
    </button>
  );
}

export function SubscriptButton({ editor }: ScriptButtonProps) {
  const isActive = editor.isActive("subscript");
  return (
    <button
      type="button"
      className="ed-script-btn"
      aria-pressed={isActive}
      aria-label="Subscrito"
      title="Subscrito (Ctrl+,)"
      onClick={() => editor.chain().focus().toggleSubscript().run()}
    >
      x<sub>2</sub>
    </button>
  );
}
