/**
 * O que o contêiner de database (DBS-001 inline / DBS-002 página inteira)
 * precisa para se desenhar — ver `docs/FASE-3-ARQUITETURA.md` §11 (esta
 * peça, S2) e §6 (os registros de propriedade/view que o corpo consome).
 *
 * Deliberadamente PURO: nenhum arquivo desta pasta chama `invoke` nem
 * conhece Postgres — a mesma separação I/O-fora-da-lógica da regra 14. Quem
 * monta a tela (o bloco do editor, ou a futura tela de página inteira)
 * resolve os dados e passa por prop. Isso também evita este componente
 * inventar a forma de um comando Rust que nenhuma peça publicou ainda:
 * `get_database_schema` está listado na arquitetura §9, mas nenhum arquivo
 * do repositório define `DatabaseSchemaRow` — ver a divergência registrada
 * no relatório desta peça.
 */
import type { PropertyType } from "../../../lib/ipc";
import type { Database, RecordRow } from "../contract";
import type { PropertyDescriptor } from "../core/property-spec";
import type { PropertyActionResult, ViewDescriptor } from "../core/view-spec";

/** DBS-001 (inline, dentro de uma nota) vs DBS-002 (página inteira, bloqueável). */
export type DatabaseContainerMode = "inline" | "fullPage";

/**
 * Uma database já resolvida para o formato que os registros de
 * propriedade/view (`core/property-spec.ts`, `core/view-spec.ts`) esperam —
 * nunca as linhas cruas de `contract.ts` (lá `config` ainda é
 * `Record<string, unknown>`, sem o `TConfig` que cada spec concreto declara).
 */
export interface DatabaseSchema {
  database: Database;
  properties: readonly PropertyDescriptor[];
  views: readonly ViewDescriptor[];
}

/**
 * Estado de carregamento do schema, no mesmo formato de três estados que
 * `usePageTreeStore`/`useVersionHistory` já usam neste repositório — quem
 * fornecer os dados de verdade (leitura por `databaseId`) devolve isto,
 * nunca `DatabaseSchema` cru, porque toda leitura por IPC tem uma janela de
 * carregamento e um caminho de erro que uma célula de UI não pode ignorar.
 * `records` anda junto do schema porque é o mesmo carregamento
 * (`list_records`) — uma view nunca fica "pronta" sem saber suas linhas.
 */
export type DatabaseContainerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; schema: DatabaseSchema; records: readonly RecordRow[] };

/**
 * Ações que o cabeçalho oferece. Cada uma é opcional de propósito: um
 * callback ausente faz o botão correspondente (Filtrar/Ordenar/+Novo) não
 * aparecer — nunca "aparece desabilitado sem função", que seria controle
 * morto (regra 10). "+ Propriedade"/"+ View" são diferentes: SEMPRE
 * aparecem (é o próprio critério de DBS-002 — o botão existe e fica
 * desabilitado, não some), desabilitados quando não há callback OU quando
 * `database.isLocked` — mas o texto explicativo (`title`) só fala da
 * database bloqueada, porque essa é a única das duas razões que é
 * informação de produto; a outra é só "esta rodada ainda não ligou isto".
 * Nenhuma das duas nunca é o tipo de propriedade da célula — é o que separa
 * DBS-002 (bloqueia estrutura) de travar edição de valor por engano.
 */
/**
 * O que `onAddProperty` devolve quando é assíncrono: o diálogo de
 * configuração (`NewPropertyDialog`) espera isto para só fechar depois de
 * a propriedade existir — em erro, ele fica aberto com a expressão intacta
 * e a mensagem do backend ao lado do botão, em vez de sumir e deixar o
 * erro aparecer noutro canto da tela.
 */
export type AddPropertyResult = { ok: true } | { ok: false; message: string };

/**
 * As escritas de ESTRUTURA que o carregador oferece e o contêiner entrega
 * à view como `PropertyActions` (`core/view-spec.ts`) — mais `setConfig`,
 * que a view nunca chama direto: ela pede `editConfig`, o contêiner abre o
 * formulário do tipo (`PropertyConfigDialog`) e é o diálogo que persiste
 * por aqui. Mesmo formato de resultado de `onAddProperty`, pelo mesmo
 * motivo: o diálogo só fecha com `ok`.
 */
export interface PropertyMutations {
  rename(propertyId: string, name: string): Promise<PropertyActionResult>;
  /** Manda junto o `defaultConfig` do tipo novo — ver `useDatabase` para a decisão. */
  changeType(propertyId: string, newType: PropertyType): Promise<PropertyActionResult>;
  setConfig(propertyId: string, config: unknown): Promise<PropertyActionResult>;
  reorder(propertyId: string, afterPropertyId: string | null): Promise<PropertyActionResult>;
  delete(propertyId: string): Promise<PropertyActionResult>;
}

export interface DatabaseContainerActions {
  /** DBS-001: "+ Novo" no cabeçalho. */
  onCreateRecord?(): void;
  onFilter?(): void;
  onSort?(): void;
  /**
   * DBS-002: gate é `database.isLocked`, NUNCA o tipo de propriedade da
   * célula. Recebe o tipo escolhido no menu e o nome (o rótulo do tipo, ou o
   * que o usuário digitou no diálogo de configuração). `config` só vem
   * quando o spec do tipo tem `renderConfigForm` e o usuário o preencheu —
   * é a `database_properties.config` inicial (ex.: `{ expression }` de uma
   * fórmula).
   */
  onAddProperty?(type: PropertyType, name: string, config?: unknown): void | Promise<AddPropertyResult>;
  onAddView?(): void;
}
