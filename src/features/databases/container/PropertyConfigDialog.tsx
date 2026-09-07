/**
 * O diálogo de configuração de uma propriedade — o `renderConfigForm` do
 * tipo (hoje, só Fórmula) dentro de uma moldura com título, nome e
 * feedback. Dois modos, o MESMO formulário:
 *
 * - **criar** (`mode: "create"`): aberto pelo "+ Propriedade" quando o tipo
 *   escolhido tem formulário; a propriedade ainda não existe (`id: ""`, o
 *   sinal que `PropertyConfigFormContext` documenta), então o nome é pedido
 *   aqui — quem escreve uma fórmula quer nomeá-la ("Média", não "Fórmula").
 * - **editar** (`mode: "edit"`): aberto pelo menu do cabeçalho da coluna
 *   ("Editar fórmula"); a propriedade existe, o formulário recebe o valor
 *   atual e um id de verdade (o validador passa a excluir a própria coluna
 *   da referência circular), e `set_property_config` persiste. Renomear não
 *   mora aqui — é no menu, ao lado.
 *
 * Portal no `body`, como `EditorFlyout`: o bloco inline vive dentro do
 * editor de blocos, e um teclado que borbulhasse até o `NodeViewWrapper`
 * seria interpretado como digitação na nota. Entrada animada (opacidade +
 * escala 0.95, `--motion-base`, ease-out): configurar uma fórmula é ação
 * rara e iniciada por clique — os dois critérios para animar
 * (DESIGN-TOKENS §9). Fechar é instantâneo.
 */
import { useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { PropertyType } from "../../../lib/ipc";
import type { RecordRow } from "../contract";
import type { PropertyDescriptor, PropertySpec } from "../core/property-spec";
import type { PropertyActionResult } from "../core/view-spec";
import { useOpenTransition } from "../../pages/use-open-transition";
import type { AddPropertyResult } from "./types";

interface CommonProps {
  spec: PropertySpec;
  databaseId: string;
  properties: readonly PropertyDescriptor[];
  records: readonly RecordRow[];
  onCancel(): void;
}

interface CreateProps extends CommonProps {
  mode: "create";
  /** Resolve quando a propriedade existe (ou não). Quem fecha o diálogo em sucesso é o dono dele; em erro, o diálogo fica aberto e mostra `message`. */
  onCreate(type: PropertyType, name: string, config: unknown): Promise<AddPropertyResult>;
}

interface EditProps extends CommonProps {
  mode: "edit";
  property: PropertyDescriptor;
  /** Mesmo contrato de `onCreate`: só `ok` fecha. */
  onSave(config: unknown): Promise<PropertyActionResult>;
}

export type PropertyConfigDialogProps = CreateProps | EditProps;

type Saving = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A config que o formulário recebe ao EDITAR: a persistida, por cima do
 * `defaultConfig` do tipo. `database_properties.config` é JSON do banco —
 * uma Fórmula pode ter chegado aqui com `{}` (criada antes de o carregador
 * mandar o padrão, ou por uma troca de tipo cuja segunda chamada falhou), e
 * `FormulaConfigForm` faz `expression.trim()` no primeiro render. Sem esta
 * fusão, uma chave ausente derrubaria o diálogo em vez de abrir vazio. É a
 * mesma família do `default:` de `formatNumberValue`: o tipo do TypeScript
 * promete a chave; o banco não.
 */
export function effectiveConfig(spec: PropertySpec, persisted: unknown): unknown {
  if (isRecord(spec.defaultConfig) && isRecord(persisted)) return { ...spec.defaultConfig, ...persisted };
  return persisted ?? spec.defaultConfig;
}

export function PropertyConfigDialog(props: PropertyConfigDialogProps) {
  const { spec, databaseId, properties, records, onCancel } = props;
  const [name, setName] = useState(spec.label);
  const [saving, setSaving] = useState<Saving>({ kind: "idle" });
  // Dois cliques rápidos em "Criar"/"Salvar" não podem gravar duas vezes.
  const inFlightRef = useRef(false);
  const entered = useOpenTransition(true);
  const ids = useId();
  const titleId = `${ids}-title`;
  const nameId = `${ids}-name`;
  const feedbackId = `${ids}-feedback`;

  async function persist(config: unknown) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSaving({ kind: "saving" });
    try {
      const result = props.mode === "create" ? await props.onCreate(spec.type as PropertyType, draft.name, config) : await props.onSave(config);
      // Em sucesso o dono já desmontou este diálogo; só o erro precisa de estado.
      if (!result.ok) setSaving({ kind: "failed", message: result.message });
    } finally {
      inFlightRef.current = false;
    }
  }

  // Ao criar, a propriedade ainda não existe: `id: ""` é o sinal que o
  // contrato de `PropertyConfigFormContext` documenta. Ao editar, é ela mesma.
  const draft: PropertyDescriptor =
    props.mode === "edit"
      ? { ...props.property, config: effectiveConfig(spec, props.property.config) }
      : {
          id: "",
          databaseId,
          name: name.trim().length > 0 ? name.trim() : spec.label,
          type: spec.type,
          config: spec.defaultConfig,
          position: "",
        };

  const title = props.mode === "edit" ? `Editar ${spec.label.toLowerCase()}: ${props.property.name}` : `Nova propriedade: ${spec.label}`;
  const savingText = props.mode === "edit" ? "Salvando…" : "Criando propriedade…";

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onCancel();
    }
    event.stopPropagation();
  }

  function stopPropagation(event: MouseEvent<HTMLDivElement>) {
    event.stopPropagation();
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4" onClick={onCancel} onPointerDown={stopPropagation}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={stopPropagation}
        onKeyDown={handleKeyDown}
        className={[
          "flex max-h-[85vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-md border border-border bg-surface p-5 shadow-hard",
          "transition-[opacity,transform] duration-[var(--motion-base)] ease-out motion-reduce:transition-none",
          entered ? "scale-100 opacity-100" : "scale-95 opacity-0",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="font-display text-lg text-ink">
              {title}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">A coluna é calculada e somente leitura; ninguém digita nela.</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Fechar" className="text-ink-muted hover:text-ink">
            ✕
          </button>
        </div>

        {props.mode === "create" ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-sm font-medium text-ink">
              Nome
            </label>
            <input
              id={nameId}
              type="text"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              autoFocus
              className="w-full max-w-sm rounded-sm border border-border bg-surface-sunken px-2 py-1.5 text-sm text-ink"
            />
          </div>
        ) : null}

        {spec.renderConfigForm?.({
          config: draft.config,
          property: draft,
          properties,
          records,
          commit: (config) => void persist(config),
        })}

        {/* O feedback fica AQUI, colado ao formulário que o causou — não ao
            lado da tabela, atrás do diálogo. Em erro, o que foi digitado
            continua na caixa: nada é perdido. */}
        {saving.kind === "saving" ? (
          <p id={feedbackId} role="status" className="text-sm text-ink-muted">
            {savingText}
          </p>
        ) : null}
        {saving.kind === "failed" ? (
          <p id={feedbackId} role="alert" className="text-sm text-terracotta-ink">
            {saving.message} O que você escreveu continua aqui — tente de novo ou feche.
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
