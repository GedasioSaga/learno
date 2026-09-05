/**
 * `renderValue` do tipo "files" (DBS-016) — fileira compacta de
 * miniaturas/ícones. Conteúdo de NÍVEL INLINE (`core/property-spec.ts`): não
 * monta caixa própria, só o que entra dentro da célula que a view já
 * desenhou (Tabela/Board/Lista) — um contêiner próprio aqui quebraria a
 * grade da Tabela e o card do Board ao mesmo tempo (arquitetura §6).
 */
import { useEffect, useState } from "react";
import { resolveMediaSrc } from "../../../editor/blocks/media/media-storage";
import type { CellDensity, FileRef } from "../../contract";

const KIND_ICON: Record<FileRef["kind"], string> = {
  image: "🖼",
  video: "🎬",
  audio: "🎵",
  file: "📎",
};

/** Card/peek têm espaço para a lista quase inteira; grid/row (linha de tabela/board) truncam e resumem o resto em "+N" — densidade muda o truncamento, nunca o renderizador (contrato do spec). */
const VISIBLE_COUNT: Record<CellDensity, number> = {
  grid: 3,
  row: 3,
  card: 8,
  peek: 8,
};

/**
 * Reusado pelo editor (`FilesEditor`) para a mesma miniatura na lista de
 * edição — um só lugar decide "isto é imagem, mostra a miniatura resolvida;
 * senão, mostra o ícone do kind".
 */
export function FileThumbnail({ file }: { file: FileRef }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (file.kind !== "image") {
      setUrl("");
      return;
    }
    let cancelled = false;
    void resolveMediaSrc(file.src).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [file.kind, file.src]);

  if (file.kind === "image" && url) {
    // Decorativo: o nome do arquivo já aparece como texto ao lado — um
    // `alt` descritivo aqui duplicaria o anúncio para leitor de tela.
    return <img src={url} alt="" className="size-5 shrink-0 rounded-sm object-cover" />;
  }
  return (
    <span aria-hidden="true" className="shrink-0 text-sm leading-none">
      {KIND_ICON[file.kind]}
    </span>
  );
}

export interface FilesCellProps {
  value: FileRef[];
  density: CellDensity;
}

export function FilesCell({ value, density }: FilesCellProps) {
  // I1: propriedade vazia não desenha nada — o mesmo vazio que a AUSÊNCIA da
  // linha em `database_record_values` representa, nunca um placeholder "0
  // arquivos" que pareça um valor.
  if (value.length === 0) return null;

  const limit = VISIBLE_COUNT[density];
  const visible = value.slice(0, limit);
  const hiddenCount = value.length - visible.length;

  return (
    <span className="flex min-w-0 items-center gap-1.5" title={value.map((file) => file.name).join(", ")}>
      {visible.map((file) => (
        <span key={file.id} className="flex min-w-0 items-center gap-1">
          <FileThumbnail file={file} />
          <span className="truncate text-xs text-ink-muted">{file.name}</span>
        </span>
      ))}
      {hiddenCount > 0 && <span className="shrink-0 text-xs text-ink-muted">+{hiddenCount}</span>}
    </span>
  );
}
