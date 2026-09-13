import { CENARIOS } from "./cenarios";

/** Ids válidos em `src/styles/theme.css` — repetidos aqui só para a mensagem de erro; a lista de verdade é o `[data-theme="..."]` daquele arquivo. */
const TEMA_PADRAO = "ambar-noturno";

/**
 * Ponto de entrada da vitrine — a rota de desenvolvimento que renderiza uma
 * tela do app com dados de fixture, sem depender do backend Tauri, para um
 * agente externo tirar screenshot em viewport fixo (ver `README.md` desta
 * pasta). `main.tsx` só decide SE monta a vitrine (guarda de
 * `import.meta.env.DEV` + `?vitrine=` na URL); qual cenário e qual tema é
 * decisão de cá, lendo a própria `location.search`.
 */
export function Vitrine() {
  const parametros = new URLSearchParams(location.search);
  const idDoCenario = parametros.get("vitrine");
  const idDoTema = parametros.get("tema") ?? TEMA_PADRAO;
  const cenario = idDoCenario ? CENARIOS[idDoCenario] : undefined;

  if (!cenario) {
    return (
      <div
        data-theme={idDoTema}
        className="flex h-screen flex-col items-center justify-center gap-2 bg-paper p-8 text-center"
      >
        <p className="text-sm font-medium text-ink">
          {idDoCenario ? `Cenário "${idDoCenario}" não existe.` : "Nenhum cenário pedido — use ?vitrine=<id>."}
        </p>
        <p className="text-xs text-ink-muted">
          Cenários disponíveis: {Object.keys(CENARIOS).join(", ") || "nenhum"}
        </p>
      </div>
    );
  }

  return (
    <div data-theme={idDoTema} className="h-screen overflow-auto bg-paper">
      {cenario.render()}
    </div>
  );
}
