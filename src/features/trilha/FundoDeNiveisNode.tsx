import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import type { EstiloComVariaveisCss, NoDeFundo } from "./tipos-do-canvas";

/**
 * As colunas de nível — UM nó cobrindo o canvas inteiro, com uma
 * `.trilha-nivel` por nível dentro (ver o porquê em `tipos-do-canvas.ts`).
 * Puramente decorativo: sem handle, sem clique, sem foco (`selectable:false,
 * focusable:false, draggable:false` postos por `TrilhaCanvas.tsx` no
 * objeto do nó) — o rótulo "raiz"/"nível N" já é texto normal, lido por
 * qualquer leitor de tela na ordem do documento, sem precisar de `aria-*`.
 */
function FundoDeNiveisNodeComponent({ data }: NodeProps<NoDeFundo>) {
  const niveis = Array.from({ length: data.totalNiveis }, (_, indice) => indice);

  return (
    <>
      {niveis.map((nivel) => {
        const estilo: EstiloComVariaveisCss = { "--nivel": nivel };
        return (
          <div
            key={nivel}
            className={["trilha-nivel", nivel % 2 === 1 ? "trilha-nivel--alternado" : null, nivel === 0 ? "trilha-nivel--raiz" : null]
              .filter(Boolean)
              .join(" ")}
            style={estilo}
          >
            <p className="trilha-nivel__rotulo">{nivel === 0 ? "raiz" : `nível ${nivel}`}</p>
          </div>
        );
      })}
    </>
  );
}

export const FundoDeNiveisNode = memo(FundoDeNiveisNodeComponent);
