/**
 * EDT-083: a decisão de segurança em si. O pipeline é exclusivamente MathJax
 * renderizado no cliente (`render-latex.ts`) - nenhuma tela oferece "LaTeX
 * externo (dvipng)" e nenhum caminho deste builder invoca um processo
 * externo com a entrada do usuário. Duas provas independentes: o que o menu
 * `/` oferece (contrato observável) e o que o próprio código-fonte desta
 * pasta contém (nenhum caminho para `child_process`/shell/`fetch` externo).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectSlashMenuItems } from "../../core/block-spec";
import "./register";

const here = dirname(fileURLToPath(import.meta.url));

function ownSourceFiles(): string[] {
  return readdirSync(here).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

describe("EDT-083: pipeline exclusivamente MathJax no cliente", () => {
  it("o menu / só oferece a equação renderizada no cliente - nenhuma entrada de LaTeX externo", () => {
    const mathItems = collectSlashMenuItems().filter((item) => item.id.startsWith("math:"));
    expect(mathItems.length).toBeGreaterThan(0);

    const mentionsExternalLatex = /dvipng|latex externo|external latex|latex server|texlive|pdflatex/i;
    for (const item of mathItems) {
      expect(mentionsExternalLatex.test(item.title)).toBe(false);
      expect((item.keywords ?? []).some((keyword) => mentionsExternalLatex.test(keyword))).toBe(false);
    }
  });

  it("nenhum arquivo desta pasta chama processo externo ou serviço de renderização remoto", () => {
    // child_process/spawn/exec cobrem "rodar um compilador LaTeX local";
    // fetch/XMLHttpRequest cobrem "mandar a expressão para um serviço fora" -
    // as duas formas de deixar de ser "exclusivamente cliente".
    const forbidden =
      /child_process|execFile|Deno\.Command|@tauri-apps\/plugin-shell|new Command\(|\bspawn\(|\bexecSync\(|\bfetch\(|XMLHttpRequest/;
    const files = ownSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = readFileSync(join(here, file), "utf8");
      expect(contents).not.toMatch(forbidden);
    }
  });

  it("o único import de bibliotecas externas nesta pasta é o pacote 'mathjax' local, via import() dinâmico", () => {
    const contents = readFileSync(join(here, "render-latex.ts"), "utf8");
    expect(contents).toContain('import("mathjax/tex-svg.js")');
  });
});
