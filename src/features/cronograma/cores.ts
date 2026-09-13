import type { BlocoPlanejado, Materia } from "../../lib/ipc";
import { rotuloDoBloco } from "./format";

/**
 * Cor por matéria na grade (`GradeSemanal.tsx`).
 *
 * Achado do revisor nesta rodada: a versão anterior derivava a cor de um
 * hash do RÓTULO (`rotuloDoBloco` — título, ou a atividade quando não há
 * título), nunca do `subjectId`. Isso não é "cor por matéria", é cor por
 * texto: duas matérias diferentes podiam colidir no hash e sair com a mesma
 * cor, e editar o título de um bloco recolorava ele mesmo a matéria sendo a
 * mesma. `corDoBloco` corrige isso com DUAS fontes, nunca misturadas na
 * mesma decisão:
 *
 * - COR POR IDENTIDADE (o caminho normal, bloco COM matéria): quando
 *   `bloco.subjectId` aponta pra uma `Materia` presente em `materias` (a
 *   lista de `listarMaterias()`, carregada por quem chama), a cor é
 *   `Materia.color` — gravada uma vez no backend, estável mesmo que o
 *   título do bloco mude depois.
 * - COR POR TEXTO (hash), ÚLTIMO RECURSO: um bloco SEM matéria
 *   (`subjectId === null`) ainda precisa de alguma cor pra pintar a célula,
 *   e não há identidade nenhuma pra ancorar nela — cai no hash do rótulo,
 *   que é estável (mesmo texto sempre a mesma cor) mas NÃO é identidade:
 *   dois rótulos diferentes podem colidir, e o texto mudando muda a cor.
 *   Também é o caminho de saída se `subjectId` aponta pra uma matéria que
 *   `materias` não tem (lista ainda carregando, ou a matéria foi removida
 *   depois que o bloco foi criado — `ON DELETE SET NULL`, ver `store.ts`
 *   `removerMateria`): mesma regra do bloco sem matéria, nunca lança.
 *
 * A lista abaixo DUPLICA os nomes de `PALETA_DE_RAMOS`
 * (`features/mapa-mental/cores-de-ramo.ts`) em vez de importá-la: o mapa
 * mental é uma pasta em que outro workflow está escrevendo nesta rodada
 * (proibida para edição), e o próprio backend já duplica esta mesma lista
 * independentemente em Rust (`VALID_SUBJECT_COLORS`, sem importar nada de
 * TypeScript) — a duplicação aqui segue o mesmo precedente: os NOMES são o
 * contrato compartilhado (as três pastas concordam neles), não uma
 * dependência de código entre features. As cores em si (os valores hex) não
 * se repetem em lugar nenhum: vêm de `src/styles/theme.css` via
 * `cronograma-grade.css`, nunca hardcoded aqui.
 */
export const CORES_DA_GRADE = [
  "amber",
  "mint",
  "azul",
  "terracotta",
  "roxo",
  "emerald",
  "vermelho",
  "brown",
] as const;

export type CorDaGrade = (typeof CORES_DA_GRADE)[number];

/**
 * Hash simples (variante do polinomial de 31, o mesmo multiplicador de
 * `String.hashCode` do Java) só para distribuir rótulos entre as 8 cores de
 * forma estável — não é hash criptográfico, não precisa ser.
 */
function hashDeString(texto: string): number {
  let hash = 0;
  for (let indice = 0; indice < texto.length; indice += 1) {
    hash = (hash * 31 + texto.charCodeAt(indice)) | 0;
  }
  return Math.abs(hash);
}

/**
 * A cor da célula/cartão de um bloco na grade — ver o porquê (identidade vs.
 * hash) no comentário de topo do arquivo. `materias` é a lista já carregada
 * de `listarMaterias()`; passar `[]` (materias ainda não chegaram) é seguro,
 * só faz todo bloco cair no hash até a lista chegar.
 */
export function corDoBloco(
  bloco: Pick<BlocoPlanejado, "title" | "activity" | "subjectId">,
  materias: readonly Materia[],
): CorDaGrade {
  if (bloco.subjectId !== null) {
    const materia = materias.find((m) => m.id === bloco.subjectId);
    if (materia) return materia.color;
  }
  const chave = rotuloDoBloco(bloco);
  return CORES_DA_GRADE[hashDeString(chave) % CORES_DA_GRADE.length];
}
