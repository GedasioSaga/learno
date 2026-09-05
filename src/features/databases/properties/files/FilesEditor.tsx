/**
 * `renderEditor` do tipo "files" (DBS-016) — anexar, remover e reordenar por
 * arrasto. Mesmo padrão de HTML5 Drag and Drop nativo (sem lib de terceiros)
 * de `src/features/pages/PageTree.tsx`: aqui não existe "aninhar", só duas
 * zonas por linha (antes/depois de quem recebe o drop), então o zoneamento é
 * mais simples que o da árvore de páginas.
 *
 * `onCommit` recebe sempre a lista NOVA inteira. Quem grava de fato (I4,
 * `apply_record_value_changes` em Rust) é a camada compartilhada que chama
 * este editor — aqui só se decide QUAL lista.
 */
import { useRef, useState, type DragEvent } from "react";
import type { FileRef } from "../../contract";
import { storeMediaFile } from "../../../editor/blocks/media/media-storage";
import { FileThumbnail } from "./FilesCell";
import { classifyFileKind, validateAttachment } from "./kind";

type DropZone = "before" | "after";

interface DropTarget {
  overId: string;
  zone: DropZone;
}

/** Metade de cima solta ANTES, metade de baixo solta DEPOIS — sem "meio" porque não há aninhamento numa lista de arquivos. */
function zoneFromPointerY(event: DragEvent<HTMLLIElement>): DropZone {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY - rect.top < rect.height / 2 ? "before" : "after";
}

/** Tira `fromId` da lista e o reinsere do lado de `toId` indicado por `zone`. Mesma lista, outra ordem — nenhum campo de `FileRef` muda. */
function reorder(list: FileRef[], fromId: string, toId: string, zone: DropZone): FileRef[] {
  if (fromId === toId) return list;
  const dragged = list.find((file) => file.id === fromId);
  if (!dragged) return list;
  const rest = list.filter((file) => file.id !== fromId);
  const anchorIndex = rest.findIndex((file) => file.id === toId);
  if (anchorIndex === -1) return list;
  const insertAt = zone === "before" ? anchorIndex : anchorIndex + 1;
  const next = [...rest];
  next.splice(insertAt, 0, dragged);
  return next;
}

/** Alternativa por teclado ao arrasto (acessibilidade) — troca de posição com o vizinho imediato. */
function moveByOne(list: FileRef[], id: string, direction: -1 | 1): FileRef[] {
  const index = list.findIndex((file) => file.id === id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export interface FilesEditorProps {
  value: FileRef[];
  onCommit: (next: FileRef[]) => void;
}

export function FilesEditor({ value, onCommit }: FilesEditorProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  async function addFiles(pickedFiles: FileList) {
    const nextErrors: string[] = [];
    let next = value;
    for (const file of Array.from(pickedFiles)) {
      const validation = validateAttachment(file);
      if (!validation.ok) {
        nextErrors.push(`${file.name}: ${validation.reason ?? "arquivo inválido."}`);
        continue;
      }
      const stored = await storeMediaFile(file);
      const attached: FileRef = {
        id: crypto.randomUUID(),
        src: stored.src,
        name: file.name,
        kind: classifyFileKind(file.type),
      };
      next = [...next, attached];
    }
    setErrors(nextErrors);
    if (next !== value) onCommit(next);
  }

  function handleDragStart(id: string, event: DragEvent<HTMLLIElement>) {
    setDraggedId(id);
    // Firefox recusa iniciar um arraste sem dado nenhum em `dataTransfer`.
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(id: string, event: DragEvent<HTMLLIElement>) {
    if (!draggedId || draggedId === id) return;
    // `preventDefault` é o que autoriza o `drop` no HTML5 DnD — sem isto o
    // navegador nunca oferece este alvo como destino válido, e por isso um
    // `drop` sobre a PRÓPRIA linha arrastada não deveria (num navegador de
    // verdade) nem chegar a `handleDrop`. A guarda de `fromId === id` lá
    // embaixo é só defesa extra para quando algo dispara o evento mesmo
    // assim (ferramenta de teste, navegador excêntrico).
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ overId: id, zone: zoneFromPointerY(event) });
  }

  function handleDrop(id: string, event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    const fromId = draggedId;
    const zone = dropTarget?.overId === id ? dropTarget.zone : zoneFromPointerY(event);
    setDraggedId(null);
    setDropTarget(null);
    // `!fromId`: nenhum arrasto em andamento. `fromId === id`: soltou sobre
    // a própria linha — não há reordenação nenhuma para gravar (ver
    // comentário em `handleDragOver`).
    if (!fromId || fromId === id) return;
    onCommit(reorder(value, fromId, id, zone));
  }

  function handleDragEnd() {
    setDraggedId(null);
    setDropTarget(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <ul role="list" aria-label="Arquivos anexados" className="flex flex-col gap-1">
        {value.map((file, index) => (
          <li
            key={file.id}
            draggable
            onDragStart={(event) => handleDragStart(file.id, event)}
            onDragOver={(event) => handleDragOver(file.id, event)}
            onDrop={(event) => handleDrop(file.id, event)}
            onDragEnd={handleDragEnd}
            data-drop-zone={dropTarget?.overId === file.id ? dropTarget.zone : undefined}
            className="flex items-center gap-2 rounded-sm border border-border bg-paper px-2 py-1 data-[drop-zone=after]:border-b-2 data-[drop-zone=after]:border-b-amber data-[drop-zone=before]:border-t-2 data-[drop-zone=before]:border-t-amber"
          >
            <span aria-hidden="true" className="cursor-grab text-ink-muted">
              ⠿
            </span>
            <FileThumbnail file={file} />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{file.name}</span>
            <button
              type="button"
              className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted hover:text-ink disabled:opacity-30"
              aria-label={`Mover ${file.name} para cima`}
              disabled={index === 0}
              onClick={() => onCommit(moveByOne(value, file.id, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted hover:text-ink disabled:opacity-30"
              aria-label={`Mover ${file.name} para baixo`}
              disabled={index === value.length - 1}
              onClick={() => onCommit(moveByOne(value, file.id, 1))}
            >
              ↓
            </button>
            <button
              type="button"
              className="grid size-6 shrink-0 place-items-center rounded-sm text-ink-muted hover:text-terracotta"
              aria-label={`Remover ${file.name}`}
              onClick={() => onCommit(value.filter((candidate) => candidate.id !== file.id))}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      {errors.length > 0 && (
        <p role="alert" className="text-xs text-terracotta">
          {errors.join(" ")}
        </p>
      )}

      <div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const picked = event.currentTarget.files;
            event.currentTarget.value = "";
            if (picked && picked.length > 0) void addFiles(picked);
          }}
        />
        <button
          type="button"
          className="rounded-sm border border-border px-2 py-1 text-xs text-ink-muted hover:text-ink"
          aria-label="Anexar arquivo"
          onClick={() => inputRef.current?.click()}
        >
          + Anexar arquivo
        </button>
      </div>
    </div>
  );
}
