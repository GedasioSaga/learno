/**
 * Linguagens registradas sob demanda (EDT-018) - o bundle inteiro do
 * highlight.js custa peso demais para um app de estudo que não precisa de
 * centenas de gramáticas raramente usadas; cada import abaixo puxa só a
 * gramática daquela linguagem, não a lib inteira.
 */
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

/** HTML usa a mesma gramática que XML no highlight.js - não há um módulo "html" separado. */
export const codeLowlight = createLowlight({
  python,
  javascript,
  typescript,
  rust,
  sql,
  json,
  bash,
  css,
  html: xml,
  markdown,
});

/** Opções do seletor de linguagem visível no bloco, na ordem pedida no checklist. */
export const CODE_LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "python", label: "Python" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "rust", label: "Rust" },
  { value: "sql", label: "SQL" },
  { value: "json", label: "JSON" },
  { value: "bash", label: "Bash" },
  { value: "css", label: "CSS" },
  { value: "html", label: "HTML" },
  { value: "markdown", label: "Markdown" },
];

export const DEFAULT_CODE_LANGUAGE = "javascript";

/** Nome do nó ProseMirror - único lugar que digita a string, o resto do pacote importa daqui. */
export const CODE_BLOCK_NODE_NAME = "codeBlock";
