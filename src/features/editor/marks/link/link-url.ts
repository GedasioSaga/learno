/**
 * EDT-043: valida a URL do popup do Ctrl/Cmd+K antes de virar link. Entrada
 * de usuário é hostil (regra de segurança do projeto) - vazia ou sem esquema
 * reconhecido ("exemplo.com" sem "https://") não vira link, e nada fora da
 * lista abaixo é aceito, o que já barra `javascript:` (o vetor clássico de
 * XSS via link) sem precisar de um caso especial só para ele.
 *
 * A própria extensão @tiptap/extension-link também rejeita `javascript:` via
 * seu `isAllowedUri` interno (confirmado lendo o `.js` instalado - protocolo
 * não está na lista que ela aceita), mas essa checagem aqui é a que dá
 * feedback ao usuário antes de tentar aplicar, e não deve depender de um
 * detalhe interno da lib para a parte de segurança.
 */
const RECOGNIZED_LINK_SCHEMES = ["http:", "https:", "mailto:", "tel:", "ftp:"];

/**
 * `null` quando a entrada não é uma URL aceitável como link (vazia, sem
 * esquema, ou esquema fora da lista reconhecida). Normaliza o valor (via
 * `URL`) quando aceita, para que o `href` salvo seja sempre bem formado.
 */
export function parseLinkUrl(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // `URL` só aceita um endereço absoluto - "exemplo.com" ou "foo bar"
    // lançam aqui, que é exatamente a checagem de "esquema reconhecido"
    // que EDT-043 pede, sem precisar de uma regex própria para isso.
    return null;
  }

  if (!RECOGNIZED_LINK_SCHEMES.includes(parsed.protocol)) return null;
  return parsed.toString();
}
