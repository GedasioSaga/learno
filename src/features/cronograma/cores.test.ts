import { describe, expect, it } from "vitest";
import type { Materia } from "../../lib/ipc";
import { CORES_DA_GRADE, corDoBloco } from "./cores";

let proximoId = 0;

function materia(overrides: Partial<Materia> = {}): Materia {
  proximoId += 1;
  return {
    id: `m${proximoId}`,
    name: "Matéria de teste",
    color: "amber",
    createdAt: "2026-09-07T00:00:00Z",
    updatedAt: "2026-09-07T00:00:00Z",
    ...overrides,
  };
}

describe("corDoBloco — cor por identidade (bloco COM matéria)", () => {
  it("usa Materia.color quando subjectId resolve numa matéria da lista, não o hash do título", () => {
    const fisica = materia({ id: "s1", color: "roxo" });
    const bloco = { title: "Aula de hoje", activity: "other" as const, subjectId: "s1" };

    expect(corDoBloco(bloco, [fisica])).toBe("roxo");
  });

  it("a cor NÃO muda quando o título muda — é o próprio bug que o revisor achou (cor por texto disfarçada de cor por matéria)", () => {
    const fisica = materia({ id: "s1", color: "roxo" });
    const antes = corDoBloco({ title: "Capítulo 1", activity: "other" as const, subjectId: "s1" }, [fisica]);
    const depois = corDoBloco({ title: "Capítulo 2 — revisão geral", activity: "other" as const, subjectId: "s1" }, [
      fisica,
    ]);

    expect(antes).toBe("roxo");
    expect(depois).toBe("roxo");
  });

  it("duas matérias diferentes com títulos que colidiriam no hash saem com cores diferentes (a identidade vence o hash)", () => {
    const materiaA = materia({ id: "sa", color: "azul" });
    const materiaB = materia({ id: "sb", color: "vermelho" });
    // Mesmo título nos dois blocos — se a cor ainda dependesse do hash do
    // rótulo, sairiam iguais; com identidade, cada uma pega a cor da sua matéria.
    const corA = corDoBloco({ title: "Revisão", activity: "other" as const, subjectId: "sa" }, [materiaA, materiaB]);
    const corB = corDoBloco({ title: "Revisão", activity: "other" as const, subjectId: "sb" }, [materiaA, materiaB]);

    expect(corA).toBe("azul");
    expect(corB).toBe("vermelho");
  });
});

describe("corDoBloco — cor por texto (hash), último recurso", () => {
  it("bloco sem matéria (subjectId null) cai no hash do rótulo — campo opcional ausente, caminho mais comum", () => {
    const cor = corDoBloco({ title: null, activity: "pomodoro", subjectId: null }, []);
    expect(CORES_DA_GRADE).toContain(cor);
  });

  it("mesmo rótulo sempre cai na mesma cor (hash estável)", () => {
    const bloco1 = { title: "Ler capítulo 3", activity: "reading" as const, subjectId: null };
    const bloco2 = { title: "Ler capítulo 3", activity: "reading" as const, subjectId: null };

    expect(corDoBloco(bloco1, [])).toBe(corDoBloco(bloco2, []));
  });

  it("subjectId aponta pra matéria que não está na lista (removida, ou lista ainda carregando) — cai no hash em vez de lançar", () => {
    const cor = corDoBloco({ title: "Bloco órfão", activity: "other" as const, subjectId: "id-que-nao-existe" }, []);
    expect(CORES_DA_GRADE).toContain(cor);
  });
});
