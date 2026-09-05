/**
 * Auto-descoberta para `property-spec.ts` e `view-spec.ts`: importar este
 * módulo carrega, de forma antecipada, todo `register.ts` sob `properties/`
 * e `views/`, para que um construtor novo nunca precise editar uma lista
 * compartilhada — soltar o arquivo na pasta basta. Mesmo mecanismo de
 * `src/features/editor/core/discover-extensions.ts`; ver o README do editor
 * para o raciocínio completo.
 *
 * O padrão do `import.meta.glob` é resolvido pelo Vite quando o dev server
 * sobe (ou no build), então uma pasta NOVA (`properties/` ou `views/`, não
 * só um arquivo novo dentro de uma que já existe) só entra depois de
 * reiniciar o `npm run dev` — custo único, documentado aqui em vez de
 * escondido.
 */
const modules = import.meta.glob(["../properties/**/register.ts", "../views/**/register.ts"], { eager: true });

/** Único trabalho real: dar a quem monta a tela de database algo para importar, para o bundler não eliminar os efeitos colaterais do glob por tree-shaking. */
export function ensureDatabaseExtensionsDiscovered(): void {
  void modules;
}
