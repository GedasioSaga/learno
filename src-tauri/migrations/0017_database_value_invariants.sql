-- Fase 3, peça N2. Núcleo das cinco invariantes (arquitetura §2) sobre
-- `database_record_values` (0009) e o pequeno conjunto de colunas/índices
-- de suporte que o resto da fase (consulta, fórmula, rollup) depende de já
-- existirem. DDL idêntico ao verificado em `docs/FASE-3-SCHEMA.sql` §0017 —
-- ver aquele arquivo para a numeração original e a nota de rejeição do
-- `database_record_index`.

-- (1) CHAVE PRIMARIA NATURAL. Medido em 716.733 linhas: a PK sintética
-- custa 34 MB duplicando a informação do UNIQUE que 0009 já cria, mais 16
-- bytes por linha na heap. Nenhum código referencia um valor pelo id
-- próprio. A tabela está VAZIA hoje — barato agora, caro depois.
ALTER TABLE database_record_values DROP CONSTRAINT database_record_values_pkey;
ALTER TABLE database_record_values DROP COLUMN id;
ALTER TABLE database_record_values ADD PRIMARY KEY (record_id, property_id);
DROP INDEX idx_database_record_values_record_id;  -- virou prefixo da PK

-- (2) VAZIO É A AUSÊNCIA DA LINHA (I1). O DEFAULT 'null' de 0009
-- contradiz a invariante: sai junto, senão um INSERT sem `value` cria
-- exatamente a linha vazia que a invariante proíbe.
-- `false` fica FORA da proibição de propósito: é valor legítimo de uma
-- fórmula booleana. Checkbox mapeia false -> apaga, e isso é do
-- normalize() do spec, provado por teste que afirma ZERO linhas.
ALTER TABLE database_record_values ALTER COLUMN value DROP DEFAULT;
ALTER TABLE database_record_values ADD CONSTRAINT chk_drv_never_empty CHECK (
  value <> 'null'::jsonb AND value <> '""'::jsonb
  AND value <> '[]'::jsonb AND value <> '{}'::jsonb
);

-- (3) AS CHAVES DE ORDENAÇÃO — o enxerto que sustenta a fase.
-- Dirigidas pela FORMA do jsonb, nunca pelo property_type: assim a Fase 6
-- acrescenta tipo sem tocar em migração.
--
-- O left(...,256) NÃO é precaução. Medido:
--   INSERT ... to_jsonb(<6 KB de md5 concatenado>)
--   ERROR: index row size 6448 exceeds btree version 4 maximum 2704
-- ou seja, a gravação FALHA na primeira vez que alguém cola um parágrafo
-- numa célula. E a armadilha: repeat('x',100000) PASSA, porque o btree
-- comprime antes de medir — um teste com texto repetitivo fica verde sobre
-- um índice que quebra o app. O fixture usa md5 concatenado.
ALTER TABLE database_record_values
  ADD COLUMN sort_num NUMERIC GENERATED ALWAYS AS (
    CASE jsonb_typeof(value)
      WHEN 'number'  THEN (value #>> '{}')::numeric
      WHEN 'boolean' THEN CASE WHEN value = 'true'::jsonb THEN 1 ELSE 0 END
      ELSE NULL
    END
  ) STORED,
  ADD COLUMN sort_text TEXT GENERATED ALWAYS AS (
    left(CASE
      WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}'
      WHEN jsonb_typeof(value) = 'object'
        THEN COALESCE(value ->> 'start', value ->> 'text')
      WHEN jsonb_typeof(value) = 'array' AND jsonb_typeof(value -> 0) = 'string'
        THEN value #>> '{0}'
      ELSE NULL
    END, 256)
  ) STORED,
  -- Instante em que ESTE valor calculado pode mudar sozinho pela passagem
  -- do tempo (fórmula que lê now()/today()). NULL = nunca, o caso de
  -- praticamente toda linha. A varredura preguiçosa lê esta coluna e
  -- ENFILEIRA na fila única de 0019 — não é um segundo mecanismo.
  ADD COLUMN stale_after TIMESTAMPTZ;

-- Índices COMPLETOS, não parciais, de propósito. A versão parcial é menor e
-- igualmente rápida, MAS o planejador só a usa se a query carregar
-- "AND sort_text IS NOT NULL" — e sem esse predicado a query devolve AS
-- MESMAS LINHAS 20x mais devagar. Nenhuma asserção de resultado pegaria.
-- `record_id` no fim é o que permite Index Only Scan (Heap Fetches: 0).
-- Medido: 42 MB e 40 MB para 716.733 linhas.
CREATE INDEX idx_drv_sort_num  ON database_record_values (property_id, sort_num,  record_id);
CREATE INDEX idx_drv_sort_text ON database_record_values (property_id, sort_text, record_id);

CREATE INDEX idx_drv_stale_after ON database_record_values (stale_after)
  WHERE stale_after IS NOT NULL;

-- (4) O GIN DE 0009 SAI. Dois arquitetos mediram, independentemente, que o
-- planejador NÃO o escolhe em nenhuma consulta real — nem na igualdade de
-- select, onde deveria brilhar. Índice que o planejador não escolhe é custo
-- puro de disco e de escrita. O combinado serve o único caso que precisa
-- mesmo de GIN (contains de multi-select): 20 ms -> 5,9 ms.
DROP INDEX idx_database_record_values_value;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE INDEX idx_drv_property_value_gin
  ON database_record_values USING GIN (property_id, value jsonb_path_ops);

-- (5) A FORMA DA DATA (I5), imposta pelo banco e não por convenção.
-- Largura fixa e zero-padding são o que fazem a ordenação lexicográfica SER
-- a cronológica. Dirigido pela forma: só vale para objeto com 'start'.
ALTER TABLE database_record_values ADD CONSTRAINT chk_drv_iso_date_shape CHECK (
  jsonb_typeof(value) <> 'object'
  OR value -> 'start' IS NULL
  OR (
    (value ->> 'start') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2})?$'
    AND (value -> 'end' IS NULL
         OR (value ->> 'end') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2})?$')
  )
);

-- (6) DBS-026 ESTÁ QUEBRADO NA FUNDAÇÃO: um UPDATE em
-- database_record_values deixa pages.updated_at byte a byte igual, então
-- "Editado em" nunca se move. Row-level e não statement-level porque foi
-- medido mais rápido (209 ms contra 302 ms num varrimento de 8.739 linhas).
--
-- O interruptor é um GUC de TRANSAÇÃO, não "ALTER TABLE ... DISABLE
-- TRIGGER": aquele pega lock e NÃO é transacional, então um import que
-- falhe no meio deixa o gatilho desligado para o app inteiro, e o sintoma é
-- "Editado em parou de funcionar" sem nada apontando para o import.
-- Caminho de massa faz SET LOCAL learno.bulk_load = 'on' e um
-- UPDATE pages SET updated_at = now() único no fim.
CREATE OR REPLACE FUNCTION touch_record_from_value() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('learno.bulk_load', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;
  UPDATE pages SET updated_at = now() WHERE id = COALESCE(NEW.record_id, OLD.record_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drv_touch_record
  AFTER INSERT OR UPDATE OR DELETE ON database_record_values
  FOR EACH ROW EXECUTE FUNCTION touch_record_from_value();

-- (7) data_version: invalida o token da consulta em duas fases. Sem ele,
-- editar uma célula e rolar serviria a ordem antiga sem sintoma nenhum.
-- Statement-level para que um lote de 20 edições não dispute 20 vezes a
-- mesma linha de `databases`.
ALTER TABLE databases ADD COLUMN data_version BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bump_database_data_version() RETURNS trigger AS $$
BEGIN
  UPDATE databases d SET data_version = d.data_version + 1
  WHERE d.id IN (SELECT DISTINCT p.database_id FROM pages p
                 JOIN changed c ON c.record_id = p.id
                 WHERE p.database_id IS NOT NULL);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drv_bump_version_ins AFTER INSERT ON database_record_values
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT
  EXECUTE FUNCTION bump_database_data_version();
CREATE TRIGGER drv_bump_version_upd AFTER UPDATE ON database_record_values
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT
  EXECUTE FUNCTION bump_database_data_version();
CREATE TRIGGER drv_bump_version_del AFTER DELETE ON database_record_values
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT
  EXECUTE FUNCTION bump_database_data_version();

-- (8) O índice que toda janela de view usa, incluindo sub-itens (DBS-118) e
-- o "AND NOT is_template" de 0020. idx_pages_database_id (0007) cobre só
-- database_id e deixa a ordenação por conta do executor.
CREATE INDEX idx_pages_database_records
  ON pages (database_id, parent_id, position)
  WHERE database_id IS NOT NULL AND deleted_at IS NULL;
