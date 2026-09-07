/**
 * O diálogo de "nova propriedade com configuração": aparece quando o tipo
 * escolhido no `AddPropertyMenu` tem `renderConfigForm` (hoje, só Fórmula).
 * Um tipo sem formulário nem passa por aqui — nasce direto, como antes.
 *
 * Só `create_property` aceita `config` (não há comando para alterar a
 * config de uma propriedade existente), então este é o ÚNICO momento em
 * que a configuração pode ser escrita — daí o diálogo ser de criação, com
 * o nome da propriedade junto: quem escreve uma fórmula quer nomeá-la
 * ("Média", não "Fórmula").
 *
 * Portal no `body`, como `EditorFlyout`: o bloco inline vive dentro do
 * editor de blocos, e um teclado que borbulhasse até o `NodeViewWrapper`
 * seria interpretado como digitação na nota. Entrada animada (opacidade +
 * escala 0.95, `--motion-base`, ease-out): criar uma fórmula é ação rara e
 * iniciada por clique — os dois critérios para animar (DESIGN-TOKENS §9).
 * Fechar é instantâneo.
 */
import { useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { PropertyType } from "../../../lib/ipc";
import type { RecordRow } from "../contract";
import type { PropertyDescriptor, PropertySpec } from "../core/property-spec";
import { useOpenTransition } from "../../pages/use-open-transition";
import type { AddPropertyResult } from "./types";

interface NewPropertyDialogProps {
  spec: PropertySpec;
  databaseId: string;
  properties: readonly PropertyDescriptor[];
  records: readonly RecordRow[];
  onCancel(): void;
  /** Resolve quando a propriedade existe (ou não). Quem fecha o diálogo em sucesso é o dono dele; em erro, o diálogo fica aberto e mostra `message`. */
  onCreate(type: PropertyType, name: string, config: unknown): Promise<AddPropertyResult>;
}

type Saving = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string };

export function NewPropertyDialog({ spec, databaseId, properties, records, onCancel, onCreate }: NewPropertyDialogProps) {
  const [name, setName] = useState(spec.label);
  const [saving, setSaving] = useState<Saving>({ kind: "idle" });
  // Dois cliques rápidos em "Criar" não podem criar duas propriedades.
  const inFlightRef = useRef(false);
  const entered = useOpenTransition(true);
  const ids = useId();
  const titleId = `${ids}-title`;
  const nameId = `${ids}-name`;
  const feedbackId = `${ids}-feedback`;

  async function create(config: unknown) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSaving({ kind: "saving" });
    try {
      const result = await onCreate(spec.type as PropertyType, draft.name, config);
      // Em sucesso o dono já desmontou este diálogo; só o erro precisa de estado.
      if (!result.ok) setSaving({ kind: "failed", message: result.message });
    } finally {
      inFlightRef.current = false;
    }
  }

  // A propriedade ainda não existe: `id: ""` é o sinal que o contrato de
  // `PropertyConfigFormContext` documenta.
  const draft: PropertyDescriptor = {
    id: "",
    databaseId,
    name: name.trim().length > 0 ? name.trim() : spec.label,
    type: spec.type,
    config: spec.defaultConfig,
    position: "",
  };

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
              Nova propriedade: {spec.label}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">A coluna é calculada e somente leitura; ninguém digita nela.</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="Fechar" className="text-ink-muted hover:text-ink">
            ✕
          </button>
        </div>

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

        {spec.renderConfigForm?.({
          config: spec.defaultConfig,
          property: draft,
          properties,
          records,
          commit: (config) => void create(config),
        })}

        {/* O feedback fica AQUI, colado ao formulário que o causou — não ao
            lado da tabela, atrás do diálogo. Em erro, o que foi digitado
            continua na caixa: nada é perdido. */}
        {saving.kind === "saving" ? (
          <p id={feedbackId} role="status" className="text-sm text-ink-muted">
            Criando propriedade…
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
