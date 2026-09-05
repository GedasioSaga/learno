/**
 * O chip de opção — usado pelo `renderValue`/`renderEditor` de `select` E de
 * `multi_select` (por isso mora aqui e é importado por `../multi_select/`).
 * `option: null` é o caso "valor órfão" (arquitetura §6): o id gravado não
 * resolve a nenhuma opção viva em `config.options` — a opção foi apagada,
 * mas o valor do registro nunca é reescrito sozinho. Renderiza um chip
 * "apagado" visível, nunca some em silêncio e nunca explode.
 */
import type { ReactNode } from "react";
import type { SelectOption } from "./option-model";

interface OptionTagProps {
  option: SelectOption | null;
  /** Presente => a tag ganha um botão "×" próprio, focável e anunciado (DBS-008: cada tag é removível isoladamente). Ausente => célula somente-leitura (renderValue). */
  onRemove?: () => void;
}

export function OptionTag({ option, onRemove }: OptionTagProps): ReactNode {
  if (option === null) {
    return (
      <span className="db-option-tag db-option-tag--orphan" title="Esta opção foi apagada da propriedade">
        Opção apagada
        {onRemove ? (
          <button type="button" className="db-option-tag__remove" aria-label="Remover opção apagada" onClick={onRemove}>
            ×
          </button>
        ) : null}
      </span>
    );
  }

  return (
    <span className="db-option-tag" data-color={option.color}>
      {option.label}
      {onRemove ? (
        <button type="button" className="db-option-tag__remove" aria-label={`Remover ${option.label}`} onClick={onRemove}>
          ×
        </button>
      ) : null}
    </span>
  );
}
