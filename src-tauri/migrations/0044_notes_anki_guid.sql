-- Nota importada de um pacote do Anki guarda o guid que tinha lá. É o que deixa
-- reimportar o mesmo baralho sem duplicar: nota com guid já presente é pulada,
-- e o progresso feito no Learno nunca é sobrescrito (`anki::importar`).
--
-- NULL para toda nota criada no próprio Learno. O índice é parcial para que
-- esses NULL não disputem a unicidade, e inclui notas na lixeira de propósito:
-- apagar uma nota importada não a faz voltar na próxima importação.
ALTER TABLE notes ADD COLUMN anki_guid TEXT;

CREATE UNIQUE INDEX idx_notes_anki_guid ON notes (anki_guid) WHERE anki_guid IS NOT NULL;
