/**
 * O registro de tipos de propriedade — o ponto de extensão que P1..P7 usam
 * para ensinar um `property_type` novo sem editar este arquivo. Mesmo papel
 * que `core/block-spec.ts` cumpriu para blocos na Fase 2: a interface
 * completa (`PropertySpec`) e o registro Map-based que a preenche moram
 * juntos aqui, e `contract.ts` fica só com o vocabulário de dados que essa
 * interface consome (`ValueShape`, `FilterOperator`, `AggregationKind`, …).
 *
 * Decisão âncora (arquitetura §6): filtro, ordenação e agregação são
 * DECLARADOS (`filterOperators`, `sort`, `aggregations`), NUNCA uma função
 * JavaScript. Se o spec expusesse `matches(value, filter): boolean`, todo
 * construtor escreveria um predicado JS, e a única forma de usá-lo seria
 * carregar as 50.000 linhas no cliente — passa verde com os 200 registros de
 * qualquer teste e morre em produção. O Rust traduz a partir de `valueShape`;
 * este registro nunca gera SQL.
 *
 * Você cria `src/features/databases/properties/<seu-tipo>/register.ts`,
 * chama `registerPropertySpec()`, e NÃO importa esse arquivo de lugar
 * nenhum — `discover-extensions.ts` o carrega por `import.meta.glob`.
 * Pegadinha herdada da Fase 2: uma pasta `properties/` que ainda não existe
 * só entra depois de reiniciar o `npm run dev`.
 */
import type { ReactNode } from "react";
import type {
  AggregationKind,
  CellDensity,
  DatabaseId,
  FilterOperator,
  PropertyId,
  RecordRow,
  ValueShape,
} from "../contract";

/**
 * A propriedade tal como um spec a vê para renderizar/editar uma célula —
 * não a linha crua de `database_properties` (`contract.ts`'s
 * `DatabaseProperty`, com `config: Record<string, unknown>`). Aqui `config`
 * já chega tipado como `TConfig`: quem lê a linha crua e monta este
 * descritor sabe, pelo próprio `type`, qual `TConfig` esperar.
 */
export interface PropertyDescriptor<TConfig = unknown> {
  id: PropertyId;
  databaseId: DatabaseId;
  name: string;
  /** `database_properties.property_type`. */
  type: string;
  config: TConfig;
  position: string;
}

export interface CellRenderContext<TValue, TConfig> {
  value: TValue;
  property: PropertyDescriptor<TConfig>;
  record: RecordRow;
  /** Tabela="grid", Board="card", Lista="row", peek/página="peek". Muda truncamento e rótulo, NÃO o renderizador. */
  density: CellDensity;
  /**
   * Vem de propriedade DERIVADA (fórmula/rollup/timestamp), NUNCA de
   * `isLocked` — DBS-002 bloqueia estrutura, jamais valor.
   */
  readOnly: boolean;
}

/**
 * O que `renderConfigForm` recebe. `properties` e `records` existem porque
 * um formulário de configuração pode precisar do RESTO da database — o
 * editor de fórmula lista as propriedades irmãs na paleta (`prop("Nome")`)
 * e avalia a prévia contra um registro real. Um formulário que não precisa
 * simplesmente os ignora.
 *
 * Ao CRIAR uma propriedade (o único caminho hoje: `create_property` é o
 * único comando que aceita `config`), `property.id` é `""` — a propriedade
 * ainda não existe. O formulário usa isso para saber que não há id a passar
 * ao backend (ex.: `validate_formula` recebe `propertyId: null`).
 */
export interface PropertyConfigFormContext<TConfig> {
  config: TConfig;
  property: PropertyDescriptor<TConfig>;
  /** As outras propriedades da database, por posição. */
  properties: readonly PropertyDescriptor[];
  /** Os registros da database — para uma prévia contra dado real. */
  records: readonly RecordRow[];
  /** Chamado só com uma config VÁLIDA; quem monta o formulário persiste. */
  commit(next: TConfig): void;
}

export interface CellEditContext<TValue, TConfig> {
  value: TValue;
  property: PropertyDescriptor<TConfig>;
  record: RecordRow;
  /** Pode ser chamado várias vezes (multi-select alterna tags); a camada compartilhada agrupa e grava em lote. */
  commit(next: TValue): void;
  /** Fecha e devolve o foco à célula de origem. */
  close(): void;
  /** >1 em edição em lote (DBS-122). O MESMO editor serve os dois casos. */
  targetCount: number;
}

/**
 * O ponto de extensão de um tipo de propriedade. Ver o cabeçalho do arquivo
 * para a decisão de "declarativo, nunca predicado JS" que molda a metade de
 * baixo desta interface.
 */
export interface PropertySpec<TValue = unknown, TConfig = unknown> {
  /** `database_properties.property_type`. Único entre todos os construtores. */
  type: string;
  label: string;
  icon: string;

  // ---- forma do valor ----
  valueShape: ValueShape;
  defaultConfig: TConfig;
  /** Valor de um registro NOVO. Só `status` usa hoje (DBS-009). */
  initialValue?(config: TConfig): TValue | null;
  /**
   * I1 aplicada a este tipo. NUNCA implemente com `!value` nem chame com
   * `!value` no lugar disto — isso come o `0` do Número e o `false` do
   * Checkbox. Ver `property-spec.test.ts` para o teste que trava exatamente
   * essa armadilha.
   */
  isEmpty(value: unknown, config: TConfig): boolean;
  /**
   * Canoniza antes de gravar. Devolver `null` APAGA a linha (I1) — é aqui
   * que checkbox transforma `false` em ausência e multi-select `[]` em
   * ausência. Chamado só no caminho de escrita (I4), nunca ao ler.
   */
  normalize(value: unknown, config: TConfig): TValue | null;
  /** jsonb -> TValue. TOTAL: nunca lança. Valor corrompido vira vazio — uma célula não pode derrubar a view. */
  parse(raw: unknown): TValue;
  serialize(value: TValue): unknown;

  // ---- renderização ----
  /**
   * Conteúdo de NÍVEL INLINE. A view é dona da caixa, da largura e do foco;
   * um renderizador que monta o próprio contêiner quebra a grade da Tabela
   * e o card do Board ao mesmo tempo.
   */
  renderValue(ctx: CellRenderContext<TValue, TConfig>): ReactNode;
  /** Ausente => propriedade somente-leitura. */
  renderEditor?(ctx: CellEditContext<TValue, TConfig>): ReactNode;
  /** Presente => ao criar uma propriedade deste tipo, o contêiner abre este formulário antes de chamar `create_property`. */
  renderConfigForm?(ctx: PropertyConfigFormContext<TConfig>): ReactNode;

  // ---- consulta: DECLARATIVA, jamais um predicado ----
  /** A UI de filtro oferece só estes; o Rust traduz a partir de `valueShape`. */
  filterOperators: readonly FilterOperator[];
  /** "configOrder" = ordem do array de opções (não alfabética pelo id). "none" = não ordenável (files, relation, button). */
  sort: "num" | "text" | "configOrder" | "none";
  /** Ausente => não se agrupa por este tipo. */
  grouping?: {
    strategy: "option" | "value" | "date_bucket";
    /** Board recusa acima disto e EXPLICA — nunca trava nem renderiza vazio. */
    maxGroups?: number;
  };
  /** Cálculos legítimos para o rodapé (DBS-058/130). Outra frente rende a UI. */
  aggregations?: readonly AggregationKind[];

  // ---- texto puro: CSV, busca, e o alvo do fixture de conformidade (§10) ----
  /** Determinística, sem locale variável. Espelhada no Rust. */
  toPlainText(value: TValue | null, config: TConfig): string;
  /** Import de CSV e colagem. `null` quando não parseia. */
  parsePlainText?(text: string, config: TConfig): TValue | null;
}

/**
 * O registro guarda specs concretos (`PropertySpec<number, NumberConfig>`,
 * `PropertySpec<boolean, CheckboxConfig>`, ...) atrás do tipo com os
 * genéricos no default (`unknown`). É erasure deliberado no LIMITE do
 * registro, não um `any` espalhado: cada `properties/<tipo>/register.ts`
 * chama `registerPropertySpec` com seus próprios `TValue`/`TConfig`
 * concretos (a chamada é type-safe do lado de quem registra), e
 * `specForPropertyType` devolve o spec já "largo" — o mesmo modo como
 * `core/block-spec.ts` guarda `BlockSpec` (lá sem genéricos porque
 * `content: BlockContent` já era `Record<string, unknown>`; aqui o valor
 * varia por tipo, por isso os genéricos existem em primeiro lugar).
 */
const propertySpecs = new Map<string, PropertySpec>();

/**
 * Declare um tipo de propriedade. Re-registrar o mesmo `type` substitui o
 * spec anterior (hot reload é inofensivo) — MAS trocar o `valueShape` de um
 * tipo já registrado lança: o Rust traduz SQL a partir dele, e uma pasta que
 * mudasse a forma silenciosamente corromperia toda consulta salva contra
 * esse tipo sem nenhum sintoma no cliente.
 */
export function registerPropertySpec<TValue, TConfig>(spec: PropertySpec<TValue, TConfig>): void {
  const existing = propertySpecs.get(spec.type);
  if (existing && existing.valueShape !== spec.valueShape) {
    throw new Error(
      `propertyType "${spec.type}" já está registrado com valueShape "${existing.valueShape}" ` +
        `e foi registrado de novo com "${spec.valueShape}". O Rust traduz SQL a partir do valueShape — ` +
        `mudar em silêncio corrompe toda consulta salva contra este tipo.`,
    );
  }
  // Erasure no limite do registro — ver o comentário do Map acima.
  propertySpecs.set(spec.type, spec as PropertySpec);
}

/** Todo spec registrado, em ordem de registro. Exposto para teste e para telas que listam "todo tipo de propriedade". */
export function collectPropertySpecs(): PropertySpec[] {
  return [...propertySpecs.values()];
}

/** O spec dono de um `property_type` persistido, ou `undefined` quando nada o reivindica (tipo de build mais novo que este). */
export function specForPropertyType(type: string): PropertySpec | undefined {
  return propertySpecs.get(type);
}

/** Test-only: apaga todo registro. Nunca chame de código de produção. */
export function resetPropertySpecRegistryForTests(): void {
  propertySpecs.clear();
}
