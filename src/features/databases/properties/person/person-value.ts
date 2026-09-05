/**
 * A metade pura de `person` (DBS-082/083/120 consomem este tipo; DBS-015 é
 * quem teria a UI completa de atribuição, fora do escopo fechado por esta
 * peça — ver `divergencias_da_arquitetura` no relatório). `PersonValue` é
 * SINGULAR (`{ name, email }`), não uma lista — confirmado pelo fixture
 * compartilhado `src-tauri/tests/fixtures/property_values.json`
 * (`person_valid_with_email`/`person_edge_without_email`, arquitetura §10),
 * a fonte da verdade quando o texto de um critério (DBS-015: "aceitando um
 * segundo nome sem remover o primeiro") e o fixture já congelado discordam.
 *
 * "Contato local" (arquitetura §6, nota de `PersonValue`): sem conta, sem
 * login, sem verificação de entrega de e-mail — é só um nome (e um e-mail
 * opcional) que o próprio usuário digitou para marcar responsabilidade
 * dentro do app, o mesmo espírito de um campo de texto com validação leve.
 */
import type { PersonValue } from "../../contract";

// Sanity check de formulário, não validação de RFC 5322: barra o caso óbvio
// ("sem @", "sem domínio") sem tentar reconhecer todo endereço válido que a
// RFC permite — este app nunca envia e-mail, só mostra/abre o cliente local
// (DBS-019 é a propriedade Email dedicada; aqui é só o contato).
const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Guarda de tipo mínima: só o campo que `normalize`/`isEmpty` de fato exigem (`name` string). `email` é conferido separadamente porque pode faltar sem tornar o valor inválido. */
function hasStringName(value: Record<string, unknown>): value is { name: string; email?: unknown } {
  return typeof value.name === "string";
}

/**
 * Canoniza um `PersonValue` bruto. `null` quando o "nome" está ausente ou é
 * só espaço — I1 aplicada aqui: um contato sem nome não é um contato vazio
 * gravado, é a AUSÊNCIA da linha (mesmo papel que `false` cumpre para
 * checkbox). `email` inválido (não bate `SIMPLE_EMAIL_PATTERN`) vira `null`
 * em vez de reprovar o `name` junto — o app aceita "só um nome, sem
 * e-mail" como valor legítimo (`person_edge_without_email` no fixture).
 */
export function normalizePersonValue(value: unknown): PersonValue | null {
  if (!isPlainObject(value) || !hasStringName(value)) return null;
  const name = value.name.trim();
  if (name === "") return null;
  const rawEmail = value.email;
  const trimmedEmail = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const email = trimmedEmail !== "" && SIMPLE_EMAIL_PATTERN.test(trimmedEmail) ? trimmedEmail : null;
  return { name, email };
}

/** I1 aplicada a `person`: vazio é "não canoniza para um contato válido", nunca `!value` (ver a mesma armadilha documentada em `core/property-spec.test.ts`). */
export function isPersonValueEmpty(value: unknown): boolean {
  return normalizePersonValue(value) === null;
}

/**
 * `jsonb -> PersonValue`. TOTAL: nunca lança. Um valor corrompido vira o
 * sentinela `{ name: "", email: null }`, que `isPersonValueEmpty` também
 * reconhece como vazio — a mesma garantia que `normalize` já dá no caminho
 * de escrita, espelhada aqui para o de leitura.
 */
export function parsePersonValue(raw: unknown): PersonValue {
  return normalizePersonValue(raw) ?? { name: "", email: null };
}

/** "Nome <email>" com e-mail, só "Nome" sem — exatamente o que o fixture de conformidade espera (arquitetura §10). Determinística, sem `Intl`. */
export function formatPersonPlainText(value: PersonValue | null): string {
  if (value === null || value.name.trim() === "") return "";
  return value.email ? `${value.name} <${value.email}>` : value.name;
}

/** O sentinela que o editor manda para APAGAR a célula (arquitetura I1): `commit()` só aceita `PersonValue`, nunca `null` (contrato de `CellEditContext`), então "remover a pessoa" precisa de um `PersonValue` que `normalizePersonValue` reconheça como vazio. */
export const EMPTY_PERSON_VALUE: PersonValue = { name: "", email: null };
