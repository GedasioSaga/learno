/**
 * DBS-004 — o editor de célula: uma instância de `Editor` do TipTap
 * COMPLETAMENTE separada do editor de blocos da Fase 2. Não reusa
 * `buildEditorExtensions()` (`src/features/editor`) de propósito — aquele
 * monta o schema `Document -> Block(blockContent, childBlocks?)` inteiro,
 * com `PageContext`, `UniqueBlockIds` e `BlockKeymap`, todos amarrados à
 * ideia de página com blocos aninhados. Uma célula de database não tem
 * página, não tem blocos, não tem filhos — só um fluxo `"inline*"` direto
 * sob `doc`, a leitura literal de "editor restrito a inline*" na
 * arquitetura §6. Construir esse schema menor aqui, com os pacotes oficiais
 * do TipTap (`@tiptap/extension-document`/`-text`/`-hard-break`, já
 * presentes em `node_modules` como dependência transitiva de
 * `@tiptap/starter-kit`/`@tiptap/react` — o mesmo status de `@tiptap/core`,
 * que `src/features/editor/core/schema.ts` já importa direto sem estar no
 * `package.json`), é a alternativa correta a montar um sub-conjunto do
 * editor de blocos e arriscar herdar um comportamento pensado para página.
 *
 * As seis marcas (negrito/itálico/riscado/sublinhado/código/link) são os
 * pacotes oficiais standalone que o projeto já usa no editor de blocos
 * (`marks/basic`, `marks/link`) — mesma versão, `^3.31.0`, já em
 * `package.json`. Nenhuma marca daqui é compartilhada por registro com o
 * editor de blocos: são duas instâncias das MESMAS extensões oficiais, não
 * a mesma extensão reaproveitada — o registro de `core/registry.ts` é
 * exclusivo do editor de blocos.
 */
import type { AnyExtension } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import Strike from "@tiptap/extension-strike";
import Text from "@tiptap/extension-text";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef, type ReactNode } from "react";
import type { CellEditContext } from "../../core/property-spec";
import "./rich-text.css";
import { sanitizeNodes, type RichTextConfig, type RichTextValue } from "./rich-text-value";

/** `doc` aceita `"inline*"` diretamente — sem `paragraph` no meio. É o que faz esta célula não ter blocos aninhados: não existe onde aninhar um. */
const CellDocument = Document.extend({ content: "inline*" });

export const RICH_TEXT_CELL_EXTENSIONS: AnyExtension[] = [
  CellDocument,
  Text,
  HardBreak,
  Bold,
  Italic,
  Strike,
  Underline,
  Code,
  // `autolink`/`linkOnPaste` desligados: colar uma URL crua numa célula de
  // Texto não é o fluxo de bookmark (DBS-028, outra propriedade); a marca
  // `link` só nasce de `Ctrl/Cmd+K`-equivalente do editor de blocos, que
  // esta célula não tem — reservado para quando essa UI existir.
  Link.configure({ openOnClick: false, autolink: false, linkOnPaste: false }),
];

export interface RichTextEditorProps {
  ctx: CellEditContext<RichTextValue, RichTextConfig>;
}

export function RichTextEditor({ ctx }: RichTextEditorProps) {
  const latestValueRef = useRef<RichTextValue>(ctx.value);
  // `ctx` muda de identidade a cada render (a camada compartilhada de célula
  // recria o objeto); o efeito de desmontagem abaixo roda só uma vez e
  // precisa do `ctx` MAIS RECENTE no momento em que desmonta, não do da
  // montagem — daí a ref em vez de capturar `ctx` direto no closure.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const editor = useEditor({
    immediatelyRender: false,
    autofocus: "end",
    extensions: RICH_TEXT_CELL_EXTENSIONS,
    content: { type: "doc", content: sanitizeNodes(ctx.value) },
    onUpdate: ({ editor: current }) => {
      latestValueRef.current = sanitizeNodes(current.getJSON().content ?? []);
    },
    editorProps: {
      attributes: {
        class: "db-rich-text-editor",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": ctx.property.name,
      },
    },
  });

  useEffect(() => {
    return () => {
      // Fecha por um caminho diferente do `onBlur` (a grade desmonta a
      // célula por rolagem, Esc já fechou antes, etc.) sem perder o que já
      // foi digitado — mesma preocupação do `flush()` no cleanup de
      // `src/features/editor/core/Editor.tsx`.
      ctxRef.current.commit(latestValueRef.current);
    };
  }, []);

  if (!editor) return null;

  function commitAndClose(): void {
    ctx.commit(latestValueRef.current);
    ctx.close();
  }

  return (
    <EditorContent
      editor={editor}
      onBlur={commitAndClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          commitAndClose();
        }
      }}
    />
  );
}

/** Adapta o componente acima à assinatura de `PropertySpec.renderEditor` (uma função, não um componente com props nomeadas). */
export function renderRichTextEditor(ctx: CellEditContext<RichTextValue, RichTextConfig>): ReactNode {
  return <RichTextEditor ctx={ctx} />;
}
