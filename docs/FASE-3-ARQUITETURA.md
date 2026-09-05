# Fase 3 — Arquitetura

> Contrato entre as peças da Fase 3, escrito **antes** de qualquer uma existir — mesmo
> papel que `src/features/editor/contract.ts` cumpriu na Fase 2. Resolve as colisões
> entre cinco desenhos independentes.
>
> **Quando este documento e uma migração discordarem, a migração vence.** Quando este
> documento e um dos cinco desenhos originais discordarem, este vence — as divergências
> estão nomeadas na §12.

---

## 1. As quatro decisões da fundação, e a única exceção

| # | Decisão de 0007/0008/0009 | Status |
|---|---|---|
| (a) | Um **registro É uma página** (`pages.database_id`), herdando lixeira, histórico e árvore | **Confirmada.** |
| (b) | Propriedade é linha em `database_properties`, com `property_type` texto e `config` jsonb | **Confirmada.** |
| (c) | Valor é linha em `database_record_values`; adicionar propriedade é INSERT, jamais ALTER TABLE | **Confirmada, com UMA exceção nomeada: a aresta de relação (§5).** |
| (d) | Config de view é blob jsonb, lido e escrito inteiro | **Confirmada.** Nenhuma consulta do pipeline olha dentro dele. |

A exceção não é licença para outras: os 13 tipos não-derivados, mais fórmula e mais
rollup, são todos linha em `database_record_values`.

---

## 2. As cinco invariantes universais

Quase todo bug caro previsto pelos cinco desenhos é a violação de uma destas.

### I1 — Vazio é a AUSÊNCIA da linha

Escrever vazio **apaga** a linha. Nenhum tipo significa vazio com `""`, `[]`, `{}` ou
`'null'::jsonb`. É o que faz DBS-054 (hide when empty), DBS-077 (`empty()`) e DBS-130
(Count empty / Percent empty) serem **uma** regra em vez de treze que discordam na mesma
tela. Imposto por CHECK.

- **Checkbox nunca grava `false`.** 50.000 cards desmarcados são 0 linhas, não 50.000.
- **Exceção nomeada:** `false` é valor legítimo vindo de **fórmula booleana** — por isso o
  CHECK proíbe `'null'`, `'""'`, `'[]'`, `'{}'` e **não** proíbe `false`. A normalização de
  checkbox vive no `normalize()` do spec e em I4, com teste que afirma ZERO linhas.
- **Armadilha em TS:** `if (!value)` come o `0` do Número e o `false` do Checkbox. Use
  `spec.isEmpty(value)`. Um card com Facilidade `0` sumindo do filtro "não vazio" é o bug
  mais provável desta fase, e a célula continua mostrando `0`, então ninguém nota.

### I2 — Nunca ordene por `value`

**Medido:** `ORDER BY value` é cronologicamente ERRADO para Data com intervalo. jsonb
compara objeto pela **quantidade de chaves** antes do conteúdo:

```
ORDER BY value                    ORDER BY value->>'start'
 B: 10/01 (so inicio)              A: 01/01 a 02/01  <- correto
 C: 01/02 (so inicio)              B: 10/01
 A: 01/01 a 02/01  <- ERRADO       C: 01/02
 D: 01/03 a 05/03                  D: 01/03 a 05/03
```

Verificado: `'{"start":"2026-01-01","end":"2026-01-02"}'::jsonb > '{"start":"2026-02-01"}'::jsonb`
é `true`. Uma database só-dia passa em **todo** teste e quebra quando alguém liga "End
date". Ordene por `sort_text` / `sort_num`.

### I3 — Toda condição sobre `sort_text` é emitida em PAR

`sort_text` é truncado em 256. Igualdade e faixa exigem
`sort_text <op> $v AND value <op> $v`: a primeira metade é a condição de índice, a segunda
restaura a exatidão. Sem a segunda, o filtro casa dois textos que compartilham os
primeiros 256 caracteres — e isso não aparece em teste com dados curtos.

**Só `src-tauri/src/db/query/predicate.rs` pode emitir SQL sobre `sort_text`/`sort_num`.**

### I4 — Existe UM caminho de escrita de valor

`apply_record_value_changes` é a única função que faz INSERT/UPDATE/DELETE em
`database_record_values`. É onde acontecem, na mesma transação: normalização por tipo,
cascata de fórmula, enfileiramento de rollup e disparo de automação.

Nada no compilador defende isso. **Vira teste:**

```
rg 'INSERT INTO database_record_values|UPDATE database_record_values|DELETE FROM database_record_values' src-tauri/src/
```

deve devolver **apenas** `db/record_values.rs`. O primeiro construtor que escrever direto
(o import de CSV é o candidato natural) apaga cascata, automação e "Editado em" de uma vez.

### I5 — Data é ISO de largura fixa, hora local de parede

`{"start": "YYYY-MM-DD"}` ou `{"start": "YYYY-MM-DDTHH:MM"}`, `"end"` opcional da mesma
largura. Sem fuso, sem segundos. `includeTime` e `hasEnd` moram na **config da
propriedade**, nunca no valor.

Largura fixa e zero-padding fazem a ordenação lexicográfica **ser** a cronológica, e fazem
`"2026-03-15"` < `"2026-03-15T14:30"` (um valor só-dia ordena no começo do seu dia). Hora
local porque o app é local, de um usuário, sem servidor e sem sync. Imposto por CHECK.

---

## 3. Modelo de dados — DDL consolidado

Cinco migrações, numeradas por mim. **Todos os cinco desenhos reservaram `0017`**; a
numeração é recurso compartilhado e colide em silêncio entre worktrees. O DDL completo,
comentado, está no campo `schema_sql`. Resumo:

| Migração | Conteúdo |
|---|---|
| `0017_database_value_invariants.sql` | PK natural, CHECK de vazio, colunas geradas `sort_num`/`sort_text`/`stale_after`, os índices, troca do GIN, CHECK de data, gatilho de DBS-026 com GUC, `databases.data_version`, índice de janela em `pages` |
| `0018_database_relations.sql` | `database_relations` + `database_relation_edges` (a exceção à decisão (c)) |
| `0019_database_derived.sql` | `rollup_dependencies` + `derived_value_queue` (fila ÚNICA) + os cinco gatilhos |
| `0020_database_graph.sql` | `pages.is_template`, `databases.config`, `database_record_dependencies` |
| `0021_database_automations.sql` | `database_automations` |

**Não existe `database_record_index`.** O read model foi construído, medido lado a lado e
recusado — ver §8 e o campo `schema_sql`.

---

## 4. Conflito 1 — onde a fórmula é avaliada

**Decisão: um motor ÚNICO, em Rust, puro. O valor é SEMPRE materializado em
`database_record_values` como linha comum. O cliente não contém nenhuma semântica de
fórmula — nem parser, nem tabela de funções, nem avaliador.**

**Por quê só em Rust.** Um valor de registro é escrito por caminhos que nunca atravessam a
webview: sync de relação de mão dupla (DBS-087) escreve o **outro** lado, automações de
cadência (DBS-121) rodam sem edição do usuário, import de CSV (DBS-123), instanciação de
template (DBS-104), e na Fase 4 o agendador SRS grava vencimento/intervalo/facilidade
depois de cada revisão. Um motor no cliente deixa cada um desses caminhos sem recálculo, e
para os que rodam sem webview aberta isso é impossível. É o mesmo raciocínio que
`0016_block_page_links.sql` já documenta para backlinks: a extração foi para um gatilho
"para ficar correta não importa qual caminho de código escreve". Aqui o gatilho não pode
ser SQL (a linguagem não é expressável em SQL), então o ponto de estrangulamento é a
função Rust de I4.

**Por quê materializado.** Filtrar ou ordenar por fórmula exige o valor das 50.000 linhas,
não das 50 visíveis. Materializado, ordenar por fórmula é o mesmo `ORDER BY sort_num` de
qualquer propriedade. Sem materializar é **impossível** — não mais lento, impossível. É a
condição de existência do pipeline de consulta, e **os cinco desenhos concordaram nela**.

**A linguagem é TOTAL:** nada lança. Divisão por zero, `sqrt(-1)`, `toNumber("abc")`,
índice fora da lista → vazio. NaN e Infinity não são representáveis em jsonb; uma
avaliação que os produzisse quebraria a gravação no meio da cascata, deixando a coluna meio
atualizada. Erro de tipo é **estático** (DBS-085); em tempo de execução só sobra o vazio.

**Vazio é um VALOR habitando todo tipo:** propaga em aritmética/texto/data, é falso em
contexto booleano, e **comparação com vazio é sempre `false`, nunca vazio**. É o que mantém
o filtro em SQL (que decide binariamente) e o motor concordando — a fronteira JSON/SQL do
achado da Fase 2. Consequência aceita: `prop("Nota") > 5` e `prop("Nota") <= 5` são ambos
falsos com Nota vazia. É o comportamento do Notion.

**Cascata e ciclo.** O grafo é DERIVADO de `config.compiled.dependsOn` — sem tabela de
arestas, porque uma database tem dezenas de propriedades e uma tabela seria uma segunda
fonte de verdade precisando de gatilho. Ciclo é detectado no **salvamento**, por DFS
incluindo a fórmula candidata, recusado com `Error::Invalid` nomeando o caminho
("ciclo: Total → Desconto → Total"). A mesma DFS devolve a ordem topológica. **A detecção
vale para o grafo CRUZANDO databases** (a aresta `traverses`) — senão uma relação de mão
dupla pode oscilar.

**Renomear propriedade** reescreve o texto das fórmulas dependentes pelos spans guardados
em `compiled.prop_name_spans`, **nunca por regex**: nome em português tem acento, aspas e
espaço, e regex sobre texto do usuário é a classe de bug que a Fase 2 pagou três vezes. A
chamada tem que estar **dentro da transação de rename**.

**Spans na fronteira IPC são convertidos de bytes UTF-8 para unidades UTF-16.** "Preço" tem
5 unidades UTF-16 e 6 bytes; o número errado desloca o sublinhado em toda fórmula com
acento, que aqui é a maioria. Um teste com nomes ASCII passa verde.

**Fora do app Tauri os três comandos rejeitam com `{ kind: "unavailable" }` e a caixa
renderiza desabilitada. NÃO existe stub.** `core/blocks-api.ts` faz fallback para
localStorage e isso é certo lá, porque a semântica de bloco é do cliente. Aqui um stub que
responde "ok" para `validate_formula` é falso-verde por construção.

---

## 5. Conflito 2 — onde a aresta de relação mora

**Decisão: tabela de aresta dedicada (`database_relation_edges`), pendurada numa tabela de
vínculo (`database_relations`). A propriedade de relação é uma JANELA sobre um extremo, não
a dona do vínculo. É a única exceção à decisão (c).**

Quatro razões medidas: recíproco **0,29 ms** contra 9,33 ms por contenção jsonb (26x, e
roda uma vez por invalidação de rollup, milhares de vezes por sessão da Fase 4);
`target_record_id` é **FK** (uma lista jsonb pode apontar para um uuid que nunca existiu, e
`0016` já teve que se defender disso com regex de uuid dentro de um gatilho); `deleted_at`
vive na página, então **lixeira e restauração saem de graça**; e o toggle mão-única↔dupla
não reescreve 50.000 arrays. Honestamente: na **leitura direta** de um viewport as duas
formas empatam (13,1 ms contra 13,5 ms) — o argumento é integridade, lixeira, toggle e
custo por invalidação, não velocidade de leitura.

O que as outras frentes precisam saber:

- **Relação NÃO tem linha em `database_record_values`.** Corrige a suposição do arquiteto 3
  (array de uuid no `value`) e a do arquiteto 4 (dentro do `doc`). Consequência: **ordenar
  por relação não existe** — nenhum item do checklist pede.
- **Mão dupla = 2 linhas de `database_properties` sobre 1 aresta**, com
  `config.end ∈ {"source","target","symmetric"}`. Nunca duas arestas espelho. Uma coluna
  recíproca "fantasma" sem linha própria não poderia ser filtrada, escondida, reordenada
  nem referenciada por `prop()` — quebraria DBS-053, 054, 055 e 102 de uma vez.
- **Auto-relação simétrica (DBS-088)** é UMA propriedade lendo os dois extremos, com a
  aresta normalizada por CHECK. O Postgres recusa a espelho; não é disciplina do app.
- **Rollup É materializado** em `database_record_values` como linha comum. É isso que faz
  filtro, ordenação, agrupamento, rodapé, fórmula sobre rollup e CSV funcionarem **sem que
  a frente de consulta aprenda o que é um rollup**. Medido: ordenar 50.000 pelo rollup
  materializado = 0,30 ms contra 465 ms recalculando sob demanda.
- **Cardinalidade (DBS-090)** validada num ponto único: `set_relation_targets` com mais ids
  que o limite é ERRO (o chamador tem bug); `add_relation_targets` num limite de 1
  SUBSTITUI — é o caminho do seletor da UI e o "impede ou substitui" do critério.
- **Filtrar por relação NÃO é contenção jsonb** — é `EXISTS` na tabela de aresta.
  `predicate.rs` publica o fragmento; a frente de relações não escreve o seu.
- **Cascatas:** apagar registro permanentemente → aresta some por FK; lixeira → aresta
  sobrevive; apagar UMA propriedade de mão dupla → vira mão única; apagar a ÚLTIMA → apaga
  relação e arestas; apagar a database alvo → propriedade sobrevivente é MARCADA `broken`,
  **nunca apagada** (apagar destruiria layout, largura e ordenação, dano irreversível
  porque a lixeira é de página, não de coluna).

---

## 6. Conflito 3 — o registro de tipos de propriedade

**Decisão: existe UM registro, no espírito do `registerBlockSpec`, com uma diferença que
decide a escala — filtro, ordenação e agregação são DECLARADOS, nunca funções JavaScript.**

Se o spec expusesse `matches(value, filter): boolean`, todo construtor escreveria um
predicado JS, e a única forma de usá-lo seria carregar os 50.000 registros no cliente. Isso
passa verde com os 200 registros de qualquer teste e morre em produção — o formato exato de
"teste que não atravessa a fronteira que a feature atravessa". O `ValueShape` fechado
preserva a extensibilidade: um tipo novo escolhe uma das nove formas e o filtro continua no
Postgres, sem tocar em Rust.

```ts
// src/features/databases/contract.ts — types-only, como o da Fase 2.

export type DatabaseId = string;
export type PropertyId = string;
export type ViewId     = string;
export type OptionId   = string;
/** Um registro É uma página, então RecordId == PageId. */
export type RecordId   = string;
export type TemplateId = RecordId;

/** O jsonb de `database_record_values.value`. Opaco fora do spec. */
export type PropertyValue = unknown;

/**
 * O conjunto FECHADO sobre o qual o Rust traduz SQL. Um tipo novo (email,
 * telefone) ESCOLHE um destes; não inventa. O tradutor faz `match` sobre
 * ValueShape, nunca sobre property_type.
 */
export type ValueShape =
  | "text"        // string jsonb nua
  | "number"      // número jsonb nu
  | "boolean"     // `true` nu (false NUNCA é gravado — I1)
  | "option"      // string = id da opção, NUNCA o rótulo
  | "option_list" // array de ids de opção
  | "date"        // DateValue
  | "person"      // PersonValue
  | "file_list"   // array de FileRef
  | "timestamp";  // virtual: lido de colunas de `pages`

/** I5. `includeTime`/`hasEnd` moram na CONFIG da propriedade, não aqui. */
export interface DateValue {
  start: string;          // "YYYY-MM-DD" ou "YYYY-MM-DDTHH:mm"
  end?: string | null;    // mesma largura de `start`
}

/** DBS-082/083/120. Contato local: não há conta, login nem perfil. */
export interface PersonValue { name: string; email: string | null }

export interface FileRef {
  id: string;
  /** Exatamente o que `storeMediaFile()` devolve (hash SHA-256). REUSAR. */
  src: string;
  name: string;
  kind: "image" | "video" | "audio" | "file";
}

export type CellDensity = "grid" | "card" | "row" | "peek";

export type FilterOperator =
  | "is" | "isNot"
  | "contains" | "doesNotContain" | "startsWith" | "endsWith"
  | "gt" | "gte" | "lt" | "lte"
  | "isBefore" | "isAfter" | "isOnOrBefore" | "isOnOrAfter" | "isWithin"
  | "isChecked" | "isNotChecked"
  | "isEmpty" | "isNotEmpty"
  | "containsAny" | "containsAll";

export type AggregationKind =
  | "count_all" | "count_values" | "count_unique"
  | "count_empty" | "count_not_empty" | "percent_empty" | "percent_not_empty"
  | "sum" | "average" | "median" | "min" | "max" | "range"
  | "earliest_date" | "latest_date" | "date_range";

export interface PropertyDescriptor<TConfig = unknown> {
  id: PropertyId;
  databaseId: DatabaseId;
  name: string;
  type: string;             // database_properties.property_type
  config: TConfig;
  position: string;
}

export interface CellRenderContext<TValue, TConfig> {
  value: TValue;
  property: PropertyDescriptor<TConfig>;
  record: RecordRow;
  /** Tabela="grid", Board="card", Lista="row", peek/página="peek".
   *  Muda truncamento e se o rótulo aparece — NÃO muda o renderizador. */
  density: CellDensity;
  /** Vem de propriedade DERIVADA (fórmula/rollup/timestamp), NUNCA de
   *  `isLocked`: DBS-002 bloqueia estrutura, jamais valor. */
  readOnly: boolean;
}

export interface CellEditContext<TValue, TConfig> {
  value: TValue;
  property: PropertyDescriptor<TConfig>;
  record: RecordRow;
  /** Pode ser chamado várias vezes (multi-select alterna tags); a camada
   *  compartilhada agrupa e grava em lote. */
  commit(next: TValue): void;
  /** Fecha e devolve o foco à célula de origem. */
  close(): void;
  /** >1 em edição em lote (DBS-122). O MESMO editor serve os dois casos. */
  targetCount: number;
}

/**
 * O ponto de extensão. Você cria
 * `src/features/databases/properties/<seu-tipo>/register.ts`, chama
 * `registerPropertySpec()`, e NÃO importa esse arquivo de lugar nenhum.
 * Pegadinha herdada da Fase 2: pasta que ainda não existia só entra depois
 * de reiniciar o `npm run dev`.
 */
export interface PropertySpec<TValue = unknown, TConfig = unknown> {
  type: string;
  label: string;
  icon: string;

  // ---- forma do valor ----
  valueShape: ValueShape;
  defaultConfig: TConfig;
  /** Valor de um registro NOVO. Só `status` usa (DBS-009). */
  initialValue?(config: TConfig): TValue | null;
  /** I1 aplicada a este tipo. NUNCA use falsy no lugar disto. */
  isEmpty(value: unknown, config: TConfig): boolean;
  /** Canoniza antes de gravar. Devolver `null` APAGA a linha — é aqui que
   *  checkbox transforma `false` em ausência e multi-select `[]` em ausência. */
  normalize(value: unknown, config: TConfig): TValue | null;
  /** jsonb -> TValue. TOTAL: nunca lança. Valor corrompido vira vazio —
   *  uma célula não pode derrubar a view. */
  parse(raw: unknown): TValue;
  serialize(value: TValue): unknown;

  // ---- renderização ----
  /** Conteúdo de NÍVEL INLINE. A view é dona da caixa, da largura e do foco;
   *  um renderizador que monta o próprio contêiner quebra a grade da Tabela
   *  e o card do Board ao mesmo tempo. */
  renderValue(ctx: CellRenderContext<TValue, TConfig>): React.ReactNode;
  /** Ausente => propriedade somente-leitura. */
  renderEditor?(ctx: CellEditContext<TValue, TConfig>): React.ReactNode;
  renderConfigForm?(ctx: {
    config: TConfig;
    property: PropertyDescriptor<TConfig>;
    commit(next: TConfig): void;
  }): React.ReactNode;

  // ---- consulta: DECLARATIVA, jamais um predicado ----
  /** A UI de filtro oferece só estes; o Rust traduz a partir de `valueShape`. */
  filterOperators: readonly FilterOperator[];
  /** "configOrder" = ordem do array de opções (não alfabética pelo id).
   *  "none" = não ordenável (files, relation, button). */
  sort: "num" | "text" | "configOrder" | "none";
  /** Ausente => não se agrupa por este tipo. */
  grouping?: {
    strategy: "option" | "value" | "date_bucket";
    /** Board recusa acima disto e EXPLICA — nunca trava nem renderiza vazio. */
    maxGroups?: number;
  };
  /** Cálculos legítimos para o rodapé (DBS-058/130). Outra frente rende a UI. */
  aggregations?: readonly AggregationKind[];

  // ---- texto puro: CSV, busca, e o alvo do fixture de conformidade ----
  /** Determinística, sem locale variável. Espelhada no Rust (§10). */
  toPlainText(value: TValue | null, config: TConfig): string;
  /** Import de CSV e colagem. `null` quando não parseia. */
  parsePlainText?(text: string, config: TConfig): TValue | null;
}

export declare function registerPropertySpec<V, C>(spec: PropertySpec<V, C>): void;
export declare function getPropertySpec(type: string): PropertySpec | undefined;
```

### Notas por tipo que não cabem na interface

- **`select`/`status`/`multi_select` guardam o ID da opção, nunca o rótulo.** Sem isso,
  renomear uma opção reescreve 50.000 linhas e invalida todo filtro salvo. Valor órfão (id
  que sumiu de `options`) renderiza como chip apagado e conta como vazio — nunca explode,
  nunca fica em branco mudo.
- **`status`** tem DUAS listas (`groups` e `options`), não opções aninhadas: assim mover uma
  opção de faixa edita UM array e a identidade da opção não se mexe. Os três grupos são
  fixos. O valor é idêntico ao de `select` **de propósito**, para que o arrasto do Board
  (DBS-043) seja um caminho de escrita, não dois.
- **`number`** guarda `0.25` e MOSTRA `25%`. Mudar `format` NUNCA reescreve valor.
- **`text`** tem duas representações (`text` achatado + `inline` estruturado) — a forma
  exata do bug FUN-044. O `text` **tem** que ser produzido pelo achatador real do editor,
  importado, nunca reescrito.
- **`url`** abre pelo plugin `opener` (`blocks/bookmark/open-url.ts`), **nunca** âncora
  crua — o repo já tem os dois padrões divergentes (EDT-027) e esta fase escolhe um.
  Recusar qualquer esquema que não seja `http:`/`https:`: célula de URL é input hostil que
  vira ação.
- **`created_time`, `last_edited_time`, `button` NÃO têm linha** em
  `database_record_values`. São virtuais, respaldadas por colunas de `pages` (ou por nada).
  `predicate.rs` precisa desse galho **uma vez** — é o mesmo que fórmula e rollup usariam se
  não fossem materializados, por isso é escrito num lugar só.

---

## 7. O efeito, e os cinco mecanismos que o compartilham

Template, botão de página (DBS-112), propriedade Botão (DBS-113), automação (DBS-121) e
deslocamento de dependência (DBS-119) decompõem em (gatilho, alvo, efeito). A coluna
**efeito** é a mesma nos cinco. O que é distinto é o **gatilho** — clique, mudança de dado
e relógio são três mecanismos e ficam três.

```ts
export type ValueSource =
  | { kind: "literal"; value: PropertyValue }
  | { kind: "today" } | { kind: "now" }
  | { kind: "copyFrom"; propertyId: PropertyId };

export interface PropertyWrite {
  propertyId: PropertyId;
  /** Snapshot do nome SÓ para exibir e para a mensagem de DBS-117.
   *  A identidade é o ID: renomear a propriedade NÃO quebra o efeito. */
  propertyNameAtConfigTime: string;
  op: "set" | "clear" | "add" | "remove" | "increment" | "toggle";
  from?: ValueSource;
}

export interface RecordEffect {
  /** Presente => cria registro nesta database. Ausente => edita o de contexto. */
  createIn?: DatabaseId;
  fromTemplate?: TemplateId;
  writes: PropertyWrite[];
  openAfter?: "none" | "sidePeek" | "fullPage";
}

/** DBS-117 generalizado: botão, template padrão, alvo de automação,
 *  propriedade de dependência, prop() de fórmula e fonte de rollup.
 *  UM validador, não seis. */
export interface BrokenReference {
  where: "buttonBlock" | "buttonProperty" | "automation" | "viewDefaultTemplate"
       | "databaseDefaultTemplate" | "dependencyDateProperty"
       | "formulaProp" | "rollupSource";
  ownerId: string;
  missing: "database" | "property" | "template" | "option" | "relation";
  missingId: string;
  lastKnownName: string;
}

export type AutomationTrigger =
  | { kind: "propertyChangedTo"; propertyId: PropertyId; value: PropertyValue }
  | { kind: "pageAdded" }
  | { kind: "cadence"; every: "hourly" | "daily" | "weekly" | "monthly" };
```

**Template não cabe inteiro no efeito:** carrega também um **corpo de blocos**, que é cópia
de página, não escrita de propriedade. São dois motores (executor + duplicação de página,
esta extraída de `db::pages::duplicate`), e é melhor admitir do que inchar `RecordEffect`.

**Um template é uma PÁGINA** com `database_id` e `is_template = true` — o nome é o título
(literal do DBS-103). Uma coluna booleana entra no MESMO predicado que toda query de view
já tem, contra o anti-join que uma tabela `database_templates` custaria sobre 50.000
registros. **Toda query de view tem que lembrar do `AND NOT is_template`**; esquecer faz o
template aparecer como registro fantasma.

**DBS-107 em três degraus:** `database_views.config.defaultTemplateId` ganha; senão
`databases.config.defaultTemplateId`; senão em branco.

**Automação dispara no Rust, dentro de I4, nunca na UI.** O critério de DBS-121 diz "por
qualquer via, incluindo Board drag-and-drop". Se o disparo morasse no handler de edição de
célula, o arrasto do Board, a edição em lote, o import de CSV e outra automação não
disparariam — e cada um passaria no seu próprio teste. **E deliberadamente não é gatilho
plpgsql:** o executor precisa avaliar `today()`, respeitar orçamento de recursão e
**relatar** falha ao usuário, e plpgsql não faz o último.

**Controle de laço:** fila dentro de UMA transação (não recursão), `depth` máximo 5 **e** um
conjunto `(automation_id, record_id)` já-disparado que limita cada automação a uma execução
por registro por ação. O par já-disparado mata o ciclo A→B→A na profundidade 2. `changed TO
x` exige valor antigo ≠ x **e** novo = x — só "novo = x" faz regravar o mesmo valor
redisparar e alimentar laço.

**Cadência roda com catch-up na abertura do app**, espelhando `backup::schedule::is_due`,
que já existe e já é testado. Não é escolha de arquitetura: a senha do Postgres da Fase 1
**nunca toca o disco** (`config/mod.rs`), então nenhum processo de fundo consegue abrir o
banco. **"A cada dia" significa "a cada dia em que o app for aberto", e essa frase precisa
aparecer no seletor de cadência da UI** — senão o usuário descobre no dado.

---

## 8. O pipeline de consulta

Duas fases. `open_view_query` roda filtro/ordenação/agrupamento/cores **uma vez** e guarda a
lista ordenada de ids atrás de um token; `fetch_view_window` fatia por offset (operação de
array) e busca as linhas por PK; `db_query_summary` é separado.

**Por quê duas fases, medido:** rolar COM FILTRO por keyset sem cache re-executa o filtro
inteiro a cada janela — **40-50 ms por frame**, gagueira visível. Sem filtro o keyset é
perfeito (**0,155 ms**, Index Only Scan). Como as duas metades pedem tratamento diferente e
o cliente não pode ser quem escolhe, o token esconde a diferença. O keyset sem estado
continua permitido como otimização **interna** do caminho sem filtro.

**Por quê três comandos e não um:** as três coisas têm frequência de invalidação diferente.
Rolar não muda total, grupos nem rodapé; trocar o cálculo de uma coluna não muda linha
nenhuma. Fundido, toda rolagem recalcularia o rodapé (medido: 182 ms fundido contra
max(8, 45, 80) ms partido).

**Construção do filtro:** AND vira `INTERSECT`, OR vira `UNION`, NOT vira `EXCEPT` — um
SELECT por condição folha. Nunca um JOIN por condição (medido: 299 ms contra 79 ms). E o
INTERSECT **compõe**, então grupos aninhados até 3 níveis são recursão sobre a mesma peça.

**Agrupamento por multi-select** coloca o registro em N grupos via
`CROSS JOIN LATERAL jsonb_array_elements`. Consequência que a UI precisa saber: **a soma
das contagens de grupo é MAIOR que `totalCount`** — não dá para usar uma para conferir a
outra.

**Rodapé é opt-in por coluna** (padrão desligado, como no Notion). Comando separado, então
rodapé lento nunca segura as linhas.

**Coloração condicional (DBS-120) é avaliada no Postgres**, junto com a janela, e cada linha
volta com `matchedColorRuleIds`. A condição de cor tem a mesma forma da de filtro **de
propósito**: se o filtro roda em SQL e a cor em JS, existem duas implementações da mesma
semântica e elas vão discordar — "Status está vazio" ocultaria uma linha e coloriria outra.
Custo desprezível: só sobre a janela (~60 linhas), nunca sobre as 50.000.

```ts
// src/features/databases/query/contract.ts

export interface FilterCondition {
  kind: "condition";
  propertyId: PropertyId;
  operator: FilterOperator;
  value?: PropertyValue;      // ausente em isEmpty/isNotEmpty
}
export interface FilterGroup {
  kind: "group";
  connective: "and" | "or";
  children: FilterNode[];
}
export type FilterNode = FilterCondition | FilterGroup;

export interface SortSpec {
  /** null = ordem manual do usuário, isto é `pages.position`. */
  propertyId: PropertyId | null;
  direction: "asc" | "desc";
}

export interface GroupSpec {
  propertyId: PropertyId;
  hideEmpty: boolean;
  order: "ascending" | "descending" | "manual";
  manualOrder?: string[];
}

export interface ColorRule {
  id: string;
  when: FilterGroup;
  target: { kind: "row" } | { kind: "property"; propertyId: PropertyId };
  /** Token do sistema visual, nunca hex — o tema claro/escuro já existe. */
  color: string;
}

export interface ViewQuery {
  databaseId: DatabaseId;
  filter: FilterNode | null;
  sorts: SortSpec[];
  /** DBS-124: busca do cabeçalho. Não mexe em `filter`. */
  search: string | null;
  /** DBS-118. Aplicado ANTES do filtro do usuário. */
  interactionFilter?: "parentsOnly" | "subItemsOnly" | "both";
  /** Calendário: SOBREPOSIÇÃO de intervalo, não contenção — um registro de
   *  28/02 a 02/03 aparece em março. */
  dateWindow?: { propertyId: PropertyId; from: string; to: string };
}

export interface GroupSummary { key: PropertyValue | null; count: number; children?: GroupSummary[] }

export interface ViewQueryHandle {
  /** Opaco. Identifica a lista ordenada de ids guardada no Rust. */
  queryToken: string;
  /** Total DEPOIS do filtro. Vira `aria-rowcount` — NUNCA o tamanho da janela. */
  totalCount: number;
  groups: GroupSummary[] | null;
  /** Sobe a cada escrita. Token vencido => Error::Invalid => cliente reabre. */
  dataVersion: number;
  /** Derivadas ainda na fila: a célula mostra o valor velho COM indicador,
   *  em vez de mentir em silêncio. */
  stalePropertyIds: PropertyId[];
}

export interface RecordRow {
  id: RecordId;
  title: string;
  icon: string | null;
  parentId: RecordId | null;          // DBS-118
  position: string;
  createdAt: string;                  // alimenta DBS-024
  updatedAt: string;                  // alimenta DBS-026
  /** Propriedade AUSENTE do mapa == vazia (I1). Não existe `null` explícito. */
  values: Record<PropertyId, PropertyValue>;
  /** DBS-120, avaliado no Postgres. O cliente só pinta. */
  matchedColorRuleIds: string[];
}

export interface FooterResult {
  propertyId: PropertyId;
  calculation: AggregationKind;
  value: number | string | null;
}

export interface QueryCommands {
  open_view_query(input: {
    databaseId: DatabaseId;
    viewId: ViewId | null;
    configOverride?: ViewQuery;   // filtro efêmero que não se salva
    group: GroupSpec | null;
    colorRules: ColorRule[];
  }): Promise<ViewQueryHandle>;

  /** Fatia a lista guardada e busca por PK. `groupKey` pede a janela de UMA
   *  coluna do Board — é o que impede um Board de 12 colunas de materializar
   *  50.000 linhas para desenhar 12 cabeçalhos. */
  fetch_view_window(input: {
    queryToken: string;
    offset: number;
    limit: number;
    groupKey?: PropertyValue | null;
    /** As colunas VISÍVEIS. Nunca "todas": 15 é 3x o custo de 5. */
    propertyIds: PropertyId[];
  }): Promise<RecordRow[]>;

  db_query_summary(input: {
    queryToken: string;
    footers: { propertyId: PropertyId; calculation: AggregationKind }[];
  }): Promise<FooterResult[]>;
}

/** O blob de `database_views.config` (decisão (d)). Toda chave é PropertyId,
 *  NUNCA índice de coluna — com índice, apagar a 2ª propriedade desloca a
 *  largura de todas as seguintes em silêncio. O leitor INTERSECTA com a lista
 *  viva de propriedades: entrada órfã é inofensiva, e o blob nunca ressuscita
 *  uma coluna apagada. */
export interface ViewConfig {
  filter: FilterNode | null;
  sorts: SortSpec[];
  group: GroupSpec | null;
  colorRules: ColorRule[];
  columnOrder: PropertyId[];                                       // DBS-055
  columnWidths: Record<PropertyId, number>;                        // DBS-056
  columnVisibility: Record<PropertyId, "always" | "hide_when_empty" | "never">; // DBS-054
  footers: Record<PropertyId, AggregationKind | null>;             // DBS-058
  frozenUpTo: PropertyId | null;                                   // DBS-057
  defaultTemplateId?: TemplateId | null;                           // DBS-107
  interactionFilter?: "parentsOnly" | "subItemsOnly" | "both";     // DBS-118
  subItemDisplay?: "nestedToggle" | "flattened" | "cardProperty";  // DBS-118
  layout?: Record<string, unknown>;   // por tipo de view
}
```

---

## 9. Comandos Rust

Todos com `#[serde(rename_all = "camelCase")]` na fronteira, como `BlockRow`
(`db/blocks.rs:52`) — **não** snake_case como `PageRow`.

```rust
// ipc/query_commands.rs
pub async fn open_view_query(state: State<'_, AppState>, input: ViewQueryInput) -> Result<ViewQueryHandle>;
pub async fn fetch_view_window(state: State<'_, AppState>, input: ViewWindowInput) -> Result<Vec<RecordRow>>;
pub async fn db_query_summary(state: State<'_, AppState>, input: SummaryInput) -> Result<Vec<FooterResult>>;

// ipc/record_commands.rs — I4 mora aqui
pub async fn apply_record_value_changes(state: State<'_, AppState>, changes: Vec<RecordValueChangeInput>) -> Result<AppliedChanges>;
pub async fn create_record(state: State<'_, AppState>, input: NewRecordInput) -> Result<RecordRow>;
pub async fn get_database_schema(state: State<'_, AppState>, database_id: Uuid) -> Result<DatabaseSchemaRow>;

// ipc/relation_commands.rs
pub async fn create_relation(state: State<'_, AppState>, input: CreateRelationInput) -> Result<CreateRelationResult>;
pub async fn set_relation_two_way(state: State<'_, AppState>, relation_id: Uuid, show_on_target: bool, reciprocal_name: Option<String>) -> Result<CreateRelationResult>;
pub async fn set_relation_cardinality(state: State<'_, AppState>, relation_id: Uuid, source_max_targets: Option<i32>, target_max_sources: Option<i32>) -> Result<RelationDefinitionRow>;
pub async fn list_relation_targets(state: State<'_, AppState>, record_id: Uuid, property_id: Uuid, limit: i64, offset: i64) -> Result<RelationTargetPage>;
/// OBRIGATÓRIO: 50 linhas visíveis são UM round trip, não 50.
pub async fn list_relation_targets_bulk(state: State<'_, AppState>, record_ids: Vec<Uuid>, property_id: Uuid, per_record_limit: i64) -> Result<Vec<RecordTargets>>;
pub async fn set_relation_targets(state: State<'_, AppState>, record_id: Uuid, property_id: Uuid, target_ids: Vec<Uuid>) -> Result<RelationTargetPage>;
pub async fn add_relation_targets(state: State<'_, AppState>, record_id: Uuid, property_id: Uuid, target_ids: Vec<Uuid>) -> Result<RelationTargetPage>;
pub async fn remove_relation_targets(state: State<'_, AppState>, record_id: Uuid, property_id: Uuid, target_ids: Vec<Uuid>) -> Result<RelationTargetPage>;
pub async fn create_rollup(state: State<'_, AppState>, database_id: Uuid, name: String, config: RollupPropertyConfigInput) -> Result<Uuid>;
pub async fn update_rollup(state: State<'_, AppState>, property_id: Uuid, config: RollupPropertyConfigInput) -> Result<()>;
pub async fn list_pending_derived(state: State<'_, AppState>, property_ids: Vec<Uuid>) -> Result<Vec<PendingDerivedRow>>;
pub async fn rebuild_derived_values(state: State<'_, AppState>, database_id: Uuid) -> Result<()>;

// ipc/formula_commands.rs — três, e mais nada
pub async fn validate_formula(state: State<'_, AppState>, database_id: Uuid, property_id: Option<Uuid>, expression: String) -> Result<FormulaValidation>;
pub async fn preview_formula(state: State<'_, AppState>, database_id: Uuid, record_id: Uuid, expression: String) -> Result<FormulaPreview>;
pub async fn list_formula_functions(state: State<'_, AppState>) -> Result<Vec<FormulaFunctionDoc>>;

// ipc/effect_commands.rs
pub async fn run_record_effect(state: State<'_, AppState>, effect: RecordEffect, context_record_id: Option<Uuid>) -> Result<EffectOutcome>;
pub async fn validate_database_references(state: State<'_, AppState>, database_id: Uuid) -> Result<Vec<BrokenReference>>;
pub async fn list_database_templates(state: State<'_, AppState>, database_id: Uuid) -> Result<Vec<TemplateRow>>;
pub async fn create_database_template(state: State<'_, AppState>, database_id: Uuid, name: String) -> Result<TemplateRow>;
pub async fn create_record_from_template(state: State<'_, AppState>, database_id: Uuid, template_id: Option<Uuid>, overrides: Vec<PropertyWriteInput>) -> Result<RecordRow>;
pub async fn set_default_template(state: State<'_, AppState>, template_id: Option<Uuid>, scope: DefaultTemplateScope) -> Result<()>;
pub async fn list_database_automations(state: State<'_, AppState>, database_id: Uuid) -> Result<Vec<DatabaseAutomation>>;
pub async fn upsert_database_automation(state: State<'_, AppState>, automation: DatabaseAutomation) -> Result<DatabaseAutomation>;
pub async fn delete_database_automation(state: State<'_, AppState>, id: Uuid) -> Result<()>;
pub async fn run_due_automations(state: State<'_, AppState>) -> Result<Vec<AutomationRunSummary>>;

// ipc/graph_commands.rs
pub async fn set_record_parent(state: State<'_, AppState>, record_id: Uuid, parent_record_id: Option<Uuid>) -> Result<RecordRow>;
pub async fn set_record_dependency(state: State<'_, AppState>, blocked_id: Uuid, blocking_id: Uuid, linked: bool) -> Result<()>;
pub async fn list_record_dependencies(state: State<'_, AppState>, database_id: Uuid) -> Result<Vec<DependencyEdge>>;

// ipc/csv_commands.rs — streaming por keyset, 1000 por fatia. NUNCA 50k em memória.
pub async fn export_database_csv(state: State<'_, AppState>, database_id: Uuid, view_id: Option<Uuid>, dest_path: String, delimiter: char, with_bom: bool) -> Result<CsvExportSummary>;
pub async fn import_database_csv(state: State<'_, AppState>, source_path: String, parent_page_id: Uuid, delimiter: char) -> Result<Uuid>;
```

**Duas fronteiras internas puras** (zero sqlx, zero tokio, testáveis sem cluster):

```rust
// src-tauri/src/rollup/mod.rs
// `per_page` tem um Vec POR PÁGINA relacionada viva; o Vec interno vazio
// significa "esta página tem o alvo vazio" — é essa distinção que separa
// count_all de count_values de count_empty, e ela se perde se você achatar.
// REUSADO VERBATIM pelo rodapé (DBS-058/130), que agrega a MESMA forma sobre
// as linhas visíveis. Se o rodapé reimplementar, DBS-094 (multi-valor conta 2)
// diverge entre célula e rodapé na mesma tela.
pub fn aggregate(function: AggregationKind, per_page: &[Vec<serde_json::Value>]) -> serde_json::Value;
pub fn explode_cell(property_type: &str, value: &serde_json::Value) -> Vec<serde_json::Value>;

// src-tauri/src/formula/core/ — o motor não faz I/O. Tudo entra por aqui,
// pré-buscado em lote, para que um map() sobre relação de 5.000 itens não
// vire N+1 consultas invisíveis dentro do avaliador.
pub trait ValueSource {
    fn value(&self, record: Uuid, property: PropertyId) -> Value;
    fn related(&self, record: Uuid, property: PropertyId) -> Vec<Uuid>;
    fn page_meta(&self, record: Uuid) -> PageMeta;
    fn property_by_name(&self, name: &str) -> Option<(PropertyId, Type)>;
}
pub fn compile(src: &str, schema: &dyn ValueSource) -> Result<Compiled, Vec<Diagnostic>>;
pub fn eval(ast: &Expr, ctx: &mut EvalCtx) -> Value;
```

---

## 10. O arquivo que impede a deriva TS/Rust

`src-tauri/tests/fixtures/property_values.json` — casos
`{ propertyType, config, value, expectedPlainText, expectedSortText, expectedSortNum,
expectedIsEmpty }` **lidos pelas duas suítes**: um `vitest` que roda o `PropertySpec` de
TypeScript e um `cargo test` que roda o espelho Rust **e** confere `sort_text`/`sort_num`
calculados **pelo Postgres** sobre o mesmo `value` inserido de verdade.

É a resposta direta à lição da Fase 2: JSON fabricado à mão não prova gatilho. O fixture é
fabricado em **um** lugar e as três representações (TS, Rust, coluna gerada) são obrigadas a
concordar. Um `vitest` que leia o fixture e um `cargo test` que fabrique seus próprios casos
é o mesmo falso-verde do `db_backlinks.rs` original.

**O fixture DEVE conter:** um texto de 6 KB de **alta entropia** (md5 concatenado, nunca
`repeat`), uma data com `end` e outra sem **na mesma propriedade**, um nome de propriedade
com acento antes do span de erro, um número `0` e um checkbox `false`.

---

## 11. Conflito 4 — ordem de construção e pastas exclusivas

### Fase A — NÚCLEO, sequencial, ninguém mais escrevendo

| # | Passo | Pasta | Por quê sequencial |
|---|---|---|---|
| **N1** | `contract.ts` + registros + `RecordSource` + janela/seleção/foco de grade | `src/features/databases/contract.ts`, `core/` | É o arquivo contra o qual todos programam |
| **N2** | Migração 0017 + caminho único de escrita + espelho Rust do spec + fixture | `src-tauri/migrations/0017_*.sql`, `db/record_values.rs` | I1..I5 são pré-requisito de tudo |
| **N3** | Extração do `PageSurface` de `PageWorkspace` | `src/features/pages/` | Arquivo de OUTRA frente; dois escritores em paralelo aqui é sobrescrita silenciosa (regra 4b) |

**Congelar `FunctionDef` em F0 antes de liberar F1..F6** não é preciosismo: seis
construtores tocando a mesma `const` recompilam a árvore inteira a cada iteração, e
`target/debug/incremental` já encheu o disco `C:` uma vez nesta máquina.

### Fase B — fan-out (26 peças, pastas exclusivas)

Ver o campo `decomposicao`. **Cada peça possui sua pasta com exclusividade.**

### Os arquivos-núcleo que NINGUÉM edita

`src-tauri/src/db/mod.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs` (a lista do
`generate_handler!`) e `src/lib/ipc.ts` recebem uma linha de **cada** frente. São o `core/`
da Fase 3. **N1 é dono deles e faz o registro final, uma vez.** Sem isso, worktrees
paralelos sobrescrevem os registros uns dos outros **sem erro nenhum** — foi exatamente o
alerta de dois dos cinco arquitetos, e o sintoma é um comando que simplesmente não existe
em runtime.

### Onde duas pastas disputam o mesmo DOM

O corolário da Fase 2: disjunção de pasta torna o paralelismo seguro **e esconde bug de
integração**. Cinco lugares, cada um exigindo um teste que monte **as duas** pastas
(peça T1):

1. **Virtualização da Tabela × editor de célula.** Se a rolagem desmonta a linha em edição,
   a âncora do popover some, o foco cai no `<body>` e o que o usuário digitou vai para
   lugar nenhum. **Regra: a linha com editor aberto fica FIXADA na janela renderizada.**
   Teste: rolar *durante* a edição.
2. **Arrastar cabeçalho de coluna × seleção/arrasto de linha.** Repetição literal de
   `interaction/drag` × `interaction/selection`: cada suíte passa sozinha e o mousedown do
   cabeçalho é comido pelo handler de linha.
3. **Arrastar card no Board × clique para abrir o registro.** Um arrasto de 3 px vira
   abertura de side peek.
4. **Side peek × clique na view de fundo.** DBS-059 exige a tabela clicável: o painel é
   `role="complementary"`, **nunca** `<dialog>` nem `aria-modal` — `aria-modal="true"` torna
   o fundo inerte por definição. E o e2e pode não pegar, porque o clique programático do
   WebdriverIO às vezes atravessa onde o usuário não consegue. **Asserção explícita: o
   painel NÃO tem `aria-modal`, e um clique numa linha do fundo muda o registro exibido.**
5. **Regra de cor × destaque de seleção.** As duas pintam o mesmo elemento de linha e brigam
   por especificidade CSS.

### Duas armadilhas de acessibilidade

- `aria-rowcount` recebe o **total filtrado** (50.000), não as linhas renderizadas (100), e
  `aria-rowindex` é o índice **absoluto**. Erro clássico de grade virtualizada: invisível a
  olho nu, devastador para leitor de tela.
- O teto de grupos do Board é uma **recusa explicada**, nunca travamento nem lista vazia.
  DBS-117 já estabelece o padrão de avisar em vez de falhar em silêncio.

---

## 12. Divergências de checklist, registradas

Mesma cerimônia dos 9 itens da Fase 1 ("Histórico de revisão"). Sem isso, a auditoria final
conta itens sem prova no tipo declarado e invalida o relatório (regra 6 da Definição de
pronto).

**1. Dezesseis itens de fórmula: `vitest` → `cargo-test`.**
DBS-062, 063, 066, 070, 071, 073, 074, 075, 076, 077, 078, 080, 082, 083, 084, 085.
O critério permanece **idêntico**; muda a ferramenta, porque o motor é Rust (§4) e um stub
em TS que aceite tudo é falso-verde por construção. Custo de teste zero: o motor é puro, sem
banco, e `cargo test` roda em milissegundos. **DBS-085 se parte em dois:** a checagem de tipo
é `cargo-test`; "o editor mostra erro em vez de salvar" é `e2e-webdriverio`.

**2. DBS-117 — o critério diz "apagada/renomeada"; o desenho torna o rename inofensivo.**
`RecordEffect` referencia propriedade por **ID**, com o nome só como snapshot de exibição,
então renomear NÃO quebra o botão — ele passa a mostrar o nome novo, comportamento melhor.
O aviso dispara em **apagada**. **Recomendo mudar o critério para "apagada".** Se não mudar,
algum construtor vai degradar o desenho (guardando o nome) para o teste passar, e aí
renomear uma coluna quebra todos os botões que a usam.

**3. DBS-016 depende de um gap de plataforma que não é desta fase.**
`capabilities/default.json` concede `fs:scope` estático em `$APPDATA/media/**`, e o usuário
com pasta de dados customizada não consegue gravar (ACHADOS-FASE-2, item 1). O conserto é
`app.fs_scope().allow_directory(..)` no tratamento de `save_data_dir`. **O e2e de DBS-016
TEM que rodar COM pasta customizada** — no padrão ele fica verde sobre feature quebrada. Não
alargar o escopo para `$APPDATA/**` para disfarçar.

**4. Propriedade Pessoa entra na Fase 3.** Não é divergência de critério, é leitura de
escopo: "Fora do escopo v1" exclui **conta de usuário** (login, cadastro, perfis
autenticados). Um campo de contato local não é conta. Sem ele, DBS-082, DBS-083 e a cláusula
"Person" de DBS-120 são insatisfazíveis.

**5. DBS-026 está quebrado na fundação já commitada.** Editar `database_record_values` não
move `pages.updated_at` — não há gatilho nenhum em `pages`. Não é divergência de checklist:
é defeito, corrigido em 0017. Registrar em `ACHADOS-FASE-3.md` ao fechar.

---

## 13. Escala

Ver o campo `escala`. Resumo: o desenho aguenta 50.000 × 15 com rolagem sub-milissegundo e
filtro em 49 ms pago uma vez. Os quatro penhascos declarados são o backfill de fórmula
(1,79 s, em fundo), o fan-out de rollup acima de 2.000 registros (adiado pela fila), a
automação de cadência sobre a database inteira (25 s se o efeito não for constante — vira
`UPDATE` set-based) e a partida fria do GIN (18,3 s na primeira leitura, que precisa estar
no orçamento do e2e).
