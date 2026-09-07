/**
 * O carregador: `databaseId` -> `DatabaseContainerState` + `ViewMutations`.
 * É o ÚNICO lugar de `src/features/databases/` que fala com o IPC de
 * database (fora de `view-config/`, que nem persiste ainda). `container/`
 * continua puro e recebe o estado por prop, como `types.ts` de lá exige.
 *
 * Três estados, mesmo formato de `usePageTreeStore`/`useVersionHistory`.
 * Escrita é otimista: a célula muda na hora, o IPC roda, e em erro a
 * database inteira é recarregada do banco (a verdade) e a mensagem vai
 * para `errorMessage`, que a tela mostra ao lado da tabela — nunca fica um
 * valor na tela que o banco não tem.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppError,
  applyRecordValueChanges,
  changePropertyType,
  createProperty,
  createRecord,
  deleteProperty,
  evaluateFormulaColumn,
  getDatabase,
  listProperties,
  listRecords,
  listViews,
  renamePage,
  renameProperty,
  reorderProperty,
  setPropertyConfig,
  validateFormula,
  type DatabasePropertyRow,
  type PropertyType,
} from "../../../lib/ipc";
import type { PropertyId, RecordId, RecordRow } from "../contract";
import type { AddPropertyResult, DatabaseContainerState, PropertyMutations } from "../container/types";
import { specForPropertyType } from "../core/property-spec";
import type { PropertyActionResult, RecordValueChange, ViewMutations } from "../core/view-spec";
import { formulaErrorValue, parseFormulaConfig } from "../properties/formula/formula-value";
import { resolveRecords, resolveSchema, toRecordRow } from "./resolve-schema";

/**
 * O resultado de uma coluna de fórmula. Três casos, porque a célula precisa
 * distingui-los:
 * - `values`: calculou; valor por registro.
 * - `error`: a EXPRESSÃO está quebrada (não compila, ou nem existe) — um
 *   fato sobre a coluna, que fica até alguém mudar a fórmula.
 * - `unavailable`: a CHAMADA falhou (IPC caindo, banco ocupado) — um fato
 *   sobre este instante, que não diz nada sobre a fórmula.
 */
type FormulaColumn =
  | { propertyId: PropertyId; values: Map<RecordId, unknown> }
  | { propertyId: PropertyId; error: string }
  | { propertyId: PropertyId; unavailable: string };

/**
 * Avalia TODAS as colunas de fórmula da database — uma chamada de
 * `evaluate_formula_column` por coluna, nunca uma por linha (`list_records`
 * não computa fórmula). `validate_formula` roda junto, em paralelo, porque
 * o Rust devolve `null` para todo registro quando a expressão não compila
 * (DBS-084 inclusive) e só o diagnóstico distingue "vazio" de "quebrado".
 * Uma coluna que falha vira erro DAQUELA coluna, nunca da database inteira.
 */
async function evaluateFormulaColumns(databaseId: string, properties: readonly DatabasePropertyRow[]): Promise<FormulaColumn[]> {
  const formulas = properties.filter((property) => property.propertyType === "formula");
  return Promise.all(
    formulas.map(async (property): Promise<FormulaColumn> => {
      const { expression } = parseFormulaConfig(property.config);
      if (expression.trim().length === 0) return { propertyId: property.id, error: "Esta fórmula ainda não tem expressão." };
      try {
        const [validation, values] = await Promise.all([
          validateFormula(databaseId, property.id, expression),
          evaluateFormulaColumn(databaseId, property.id),
        ]);
        if (!validation.valid) {
          const message = validation.diagnostics[0]?.message ?? "A expressão não compila.";
          return { propertyId: property.id, error: message };
        }
        return { propertyId: property.id, values: new Map(values.map((entry) => [entry.recordId, entry.value])) };
      } catch (error) {
        return { propertyId: property.id, unavailable: messageFor(error, "Não foi possível calcular esta fórmula.") };
      }
    }),
  );
}

/**
 * Injeta os valores calculados no mapa de cada registro: `null` some (I1);
 * expressão quebrada vira o sentinela que a célula sabe mostrar. Uma
 * chamada que falhou NÃO apaga o último valor bom — um soluço de IPC num
 * recálculo não pode transformar uma fórmula certa em "fórmula inválida";
 * só quando não há valor anterior nenhum (primeira carga) o sentinela
 * entra, com a mensagem da falha, porque uma coluna em branco esconderia
 * o problema.
 */
function mergeFormulaColumns(records: readonly RecordRow[], columns: readonly FormulaColumn[]): RecordRow[] {
  if (columns.length === 0) return [...records];
  return records.map((record) => {
    const values = { ...record.values };
    for (const column of columns) {
      if ("error" in column) {
        values[column.propertyId] = formulaErrorValue(column.error);
        continue;
      }
      if ("unavailable" in column) {
        if (!(column.propertyId in values)) values[column.propertyId] = formulaErrorValue(column.unavailable);
        continue;
      }
      const value = column.values.get(record.id);
      if (value === null || value === undefined) delete values[column.propertyId];
      else values[column.propertyId] = value;
    }
    return { ...record, values };
  });
}

export interface UseDatabaseResult {
  state: DatabaseContainerState;
  /** `null` enquanto não há database pronta — nada para escrever. */
  mutations: ViewMutations | null;
  /** Último erro de ESCRITA (leitura falha vai para `state.status === "error"`). `null` = nenhum. */
  errorMessage: string | null;
  /**
   * DBS-002: cria uma propriedade do tipo pedido (com a `config` inicial,
   * quando o tipo pede uma — fórmula) e recarrega o schema. Em erro, além
   * de `errorMessage`, devolve a mensagem — é o que deixa o diálogo de
   * configuração ficar aberto com o que o usuário escreveu.
   */
  addProperty(type: PropertyType, name: string, config?: unknown): Promise<AddPropertyResult>;
  /** As escritas de ESTRUTURA do menu de coluna. `null` enquanto não há database pronta. */
  propertyMutations: PropertyMutations | null;
  reload(): Promise<void>;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

export function useDatabase(databaseId: string | null): UseDatabaseResult {
  const [state, setState] = useState<DatabaseContainerState>({ status: "loading" });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Uma troca de `databaseId` durante um carregamento em voo não pode deixar
  // a resposta antiga pousar por cima da nova — mesma guarda de
  // `selecionarTrilha` em `features/trilha/store.ts`.
  const requestRef = useRef(0);
  // A mesma guarda para ESCRITA, por célula: duas edições sobrepostas na
  // mesma `(recordId, propertyId)` (checkbox clicado duas vezes rápido) são
  // duas chamadas em voo, e a resposta da primeira pode chegar por último.
  // Cada chamada carimba um número por célula; ao voltar, só o resultado da
  // chamada mais nova daquela célula é adotado — o mais velho é descartado.
  const writeSeqRef = useRef(new Map<string, number>());
  // As propriedades cruas da última carga — o que `refreshFormulaColumns`
  // precisa para saber QUAIS colunas recalcular depois de uma escrita.
  const propertiesRef = useRef<DatabasePropertyRow[]>([]);
  // A guarda de sequência dos RECÁLCULOS de fórmula — a mesma classe de
  // corrida de `writeSeqRef`: duas escritas rápidas disparam dois
  // recálculos, e o da primeira pode voltar por último com a conta do
  // estado anterior. Cada recálculo carimba um número; só o mais novo
  // funde o resultado. `requestRef` não serve aqui: ele só sobe em
  // `reload()`, então nunca distinguiria dois recálculos entre si.
  const formulaSeqRef = useRef(0);

  const reload = useCallback(async () => {
    if (databaseId === null) {
      setState({ status: "error", message: "Este bloco de database ainda não foi vinculado a uma database." });
      return;
    }
    const request = ++requestRef.current;
    try {
      const [database, properties, views, records] = await Promise.all([
        getDatabase(databaseId),
        listProperties(databaseId),
        listViews(databaseId),
        listRecords(databaseId),
      ]);
      if (request !== requestRef.current) return;
      // Segunda rodada, só para colunas de fórmula: precisa dos ids das
      // propriedades, que a primeira acabou de trazer.
      const formulaColumns = await evaluateFormulaColumns(databaseId, properties);
      if (request !== requestRef.current) return;
      propertiesRef.current = properties;
      setState({
        status: "ready",
        schema: resolveSchema(database, properties, views),
        records: mergeFormulaColumns(resolveRecords(records), formulaColumns),
      });
    } catch (error) {
      if (request !== requestRef.current) return;
      setState({ status: "error", message: messageFor(error, "Não foi possível carregar esta database.") });
    }
  }, [databaseId]);

  useEffect(() => {
    setState({ status: "loading" });
    setErrorMessage(null);
    void reload();
  }, [reload]);

  const updateRecords = useCallback((update: (records: readonly RecordRow[]) => RecordRow[]) => {
    setState((current) => (current.status === "ready" ? { ...current, records: update(current.records) } : current));
  }, []);

  /**
   * Depois de uma escrita bem-sucedida, as colunas de fórmula que dependem
   * do que mudou estão desatualizadas na tela. Recalcula TODAS as colunas
   * de fórmula (uma chamada por coluna) em vez de rastrear `depends_on`:
   * uma database tem poucas fórmulas, e o custo de um recálculo a mais é
   * menor que o de mostrar um valor que o banco já não tem. Falha aqui não
   * é erro de escrita — a escrita já foi — então não recarrega nem avisa;
   * a coluna mostra o motivo no próprio sentinela.
   */
  const refreshFormulaColumns = useCallback(async () => {
    if (databaseId === null || !propertiesRef.current.some((property) => property.propertyType === "formula")) return;
    const request = requestRef.current;
    const seq = ++formulaSeqRef.current;
    const columns = await evaluateFormulaColumns(databaseId, propertiesRef.current);
    // Superado por um recálculo mais novo, ou por uma recarga inteira: descarta.
    if (seq !== formulaSeqRef.current || request !== requestRef.current) return;
    updateRecords((records) => mergeFormulaColumns(records, columns));
  }, [databaseId, updateRecords]);

  /** Em erro de escrita, o banco é a verdade: recarrega e avisa. */
  const failWrite = useCallback(
    async (error: unknown, fallback: string) => {
      setErrorMessage(messageFor(error, fallback));
      await reload();
    },
    [reload],
  );

  const applyValueChanges = useCallback(
    async (changes: readonly RecordValueChange[]) => {
      if (changes.length === 0) return;
      // Otimista: a célula mostra o valor novo antes do IPC voltar. Um
      // `null` some do mapa (I1) em vez de virar `values[id] = null`.
      updateRecords((records) =>
        records.map((record) => {
          const own = changes.filter((change) => change.recordId === record.id);
          if (own.length === 0) return record;
          const values = { ...record.values };
          for (const change of own) {
            if (change.value === null) delete values[change.propertyId];
            else values[change.propertyId] = change.value;
          }
          return { ...record, values };
        }),
      );
      const seqOf = (recordId: string, propertyId: string) => `${recordId}/${propertyId}`;
      const mySeq = new Map<string, number>();
      for (const change of changes) {
        const key = seqOf(change.recordId, change.propertyId);
        const next = (writeSeqRef.current.get(key) ?? 0) + 1;
        writeSeqRef.current.set(key, next);
        mySeq.set(key, next);
      }
      try {
        const applied = await applyRecordValueChanges(
          changes.map((change) => ({ recordId: change.recordId, propertyId: change.propertyId, value: change.value })),
        );
        // Só os resultados que ainda são os MAIS NOVOS da sua célula —
        // uma resposta superada por outra escrita chega tarde e é ignorada.
        const current = applied.results.filter((result) => {
          const key = seqOf(result.recordId, result.propertyId);
          return writeSeqRef.current.get(key) === mySeq.get(key);
        });
        // O Rust normaliza por tipo (`""` de texto vira ausência, `false`
        // de checkbox idem): o que ele devolve é o que está no banco, e é
        // isso que a célula passa a mostrar — não o rascunho otimista.
        updateRecords((records) =>
          records.map((record) => {
            const own = current.filter((result) => result.recordId === record.id);
            if (own.length === 0) return record;
            const values = { ...record.values };
            for (const result of own) {
              if (result.value === null) delete values[result.propertyId];
              else values[result.propertyId] = result.value.value;
            }
            return { ...record, values };
          }),
        );
        setErrorMessage(null);
        await refreshFormulaColumns();
      } catch (error) {
        await failWrite(error, "Não foi possível salvar o valor da célula.");
      }
    },
    [failWrite, refreshFormulaColumns, updateRecords],
  );

  const renameRecord = useCallback(
    async (recordId: RecordId, title: string) => {
      updateRecords((records) => records.map((record) => (record.id === recordId ? { ...record, title } : record)));
      try {
        await renamePage(recordId, title);
        setErrorMessage(null);
        // O título é `PageMeta.title` para a fórmula — pode entrar no cálculo.
        await refreshFormulaColumns();
      } catch (error) {
        await failWrite(error, "Não foi possível renomear o registro.");
      }
    },
    [failWrite, refreshFormulaColumns, updateRecords],
  );

  const createRecordMutation = useCallback(async (): Promise<RecordId> => {
    if (databaseId === null) throw new Error("sem database para criar registro");
    try {
      const page = await createRecord(databaseId, "");
      const row = toRecordRow({ page, values: [] });
      updateRecords((records) => [...records, row]);
      setErrorMessage(null);
      // O registro novo precisa da sua linha na coluna calculada (uma
      // fórmula sem `prop()` — `now()`, um literal — tem valor mesmo vazio).
      await refreshFormulaColumns();
      return row.id;
    } catch (error) {
      await failWrite(error, "Não foi possível criar o registro.");
      throw error;
    }
  }, [databaseId, failWrite, refreshFormulaColumns, updateRecords]);

  const addProperty = useCallback(
    async (type: PropertyType, name: string, config?: unknown): Promise<AddPropertyResult> => {
      if (databaseId === null) return { ok: false, message: "Este bloco de database ainda não foi vinculado a uma database." };
      try {
        // Sem config explícita, manda o `defaultConfig` do tipo em vez de
        // deixar o Rust gravar `{}`.
        //
        // `create_property` (`db/databases.rs`) grava `{}` quando o config
        // vem ausente, por desenho — o Rust não conhece `PropertySpec`, que
        // é TypeScript, então ele não tem como saber o padrão de cada tipo.
        // O resultado era uma propriedade Número nascendo com `{}` e a
        // célula ficando MUDA para sempre, porque `format` chegava
        // `undefined` no formatador. O valor gravava certo; só não aparecia.
        //
        // O padrão de cada tipo mora do lado que o conhece — aqui — e não
        // vira uma segunda cópia dentro do Rust, que sairia de sincronia na
        // primeira vez que alguém mudasse um `defaultConfig`.
        const efetiva = config ?? specForPropertyType(type)?.defaultConfig;
        await (efetiva === undefined
          ? createProperty(databaseId, name, type)
          : createProperty(databaseId, name, type, efetiva));
        setErrorMessage(null);
        await reload();
        return { ok: true };
      } catch (error) {
        const fallback = "Não foi possível criar a propriedade.";
        await failWrite(error, fallback);
        return { ok: false, message: messageFor(error, fallback) };
      }
    },
    [databaseId, failWrite, reload],
  );

  /**
   * O molde de toda escrita de ESTRUTURA: roda o IPC, recarrega a database
   * inteira (o schema mudou — colunas, tipos, fórmulas a recalcular — e o
   * banco é a verdade), e devolve o resultado no formato que o diálogo
   * espera. Em erro, `failWrite` já recarregou e avisou; a mensagem volta
   * também, para quem pediu decidir se a mostra colada ao formulário.
   */
  const structuralWrite = useCallback(
    async (write: () => Promise<unknown>, fallback: string): Promise<PropertyActionResult> => {
      try {
        await write();
        setErrorMessage(null);
        await reload();
        return { ok: true };
      } catch (error) {
        await failWrite(error, fallback);
        return { ok: false, message: messageFor(error, fallback) };
      }
    },
    [failWrite, reload],
  );

  const propertyMutations: PropertyMutations | null =
    state.status === "ready" && databaseId !== null
      ? {
          rename: (propertyId, name) => structuralWrite(() => renameProperty(propertyId, name), "Não foi possível renomear a propriedade."),
          // Trocar o tipo deixa o `config` do tipo ANTIGO para trás no banco
          // (`change_property_type` só muda `property_type`) — uma coluna
          // Número `{ format: "plain" }` que vira Texto ficaria com aquele
          // formato sem sentido, e uma que virasse Fórmula não teria
          // `expression` nenhuma. É a mesma classe de estado do defeito da
          // célula muda (ver `addProperty` acima): config que não é a do
          // tipo. Por isso o `defaultConfig` do tipo novo vai logo atrás,
          // pelo mesmo caminho que a criação já usa.
          //
          // São duas chamadas, não uma transação. Se a segunda falhar, o
          // banco fica com tipo novo + config antiga — exatamente o que o
          // Rust já permitia antes desta tela — e `failWrite` recarrega e
          // avisa; a célula não fica muda porque todo formatador de célula é
          // total (`formatNumberValue` tem `default:`). A ordem é tipo
          // primeiro porque é a intenção do usuário; a config é a limpeza.
          changeType: (propertyId, newType) =>
            structuralWrite(async () => {
              await changePropertyType(propertyId, newType);
              const defaultConfig = specForPropertyType(newType)?.defaultConfig;
              if (defaultConfig !== undefined) await setPropertyConfig(propertyId, defaultConfig);
            }, "Não foi possível mudar o tipo da propriedade."),
          setConfig: (propertyId, config) =>
            structuralWrite(() => setPropertyConfig(propertyId, config), "Não foi possível salvar a configuração da propriedade."),
          reorder: (propertyId, afterPropertyId) =>
            structuralWrite(() => reorderProperty(databaseId, propertyId, afterPropertyId), "Não foi possível mover a propriedade."),
          delete: (propertyId) => structuralWrite(() => deleteProperty(propertyId), "Não foi possível apagar a propriedade."),
        }
      : null;

  const mutations: ViewMutations | null =
    state.status === "ready" ? { applyValueChanges, renameRecord, createRecord: createRecordMutation } : null;

  return { state, mutations, errorMessage, addProperty, propertyMutations, reload };
}
