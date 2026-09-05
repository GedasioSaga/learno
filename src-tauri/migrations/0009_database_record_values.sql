-- One row per (record, property) pair. A record is a page (pages.database_id
-- set); its property values live here instead of as columns on `pages`, so
-- adding a property is an INSERT into `database_properties`, never an ALTER
-- TABLE on a data table.
--
-- Duas coisas que a versão Postgres só resolvia depois, em 0017, via `ALTER
-- TABLE ... DROP CONSTRAINT` / `ADD PRIMARY KEY` / `ADD CONSTRAINT CHECK`,
-- já nascem certas aqui: SQLite não tem NENHUMA dessas três formas de
-- `ALTER TABLE` (só permite renomear tabela/coluna e adicionar coluna) — uma
-- chave primária composta ou um CHECK sobre uma coluna já existente só podem
-- ser declarados na criação da tabela, nunca depois. O que 0017 ainda PODE
-- fazer depois (`sort_num`/`sort_text`/`stale_after`, os índices que os
-- usam, o gatilho que toca `pages.updated_at`) continua lá — SQLite aceita
-- `ALTER TABLE ADD COLUMN` com coluna gerada, verificado.
CREATE TABLE database_record_values (
    record_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    property_id TEXT NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
    -- Every property type's value fits JSON (number, string, string[], bool,
    -- a date range, a file list, a relation's target id list); the property
    -- row says how to interpret it, so this table never needs a column per
    -- type.
    --
    -- I1 (arquitetura §2): vazio é a AUSÊNCIA da linha, nunca um valor. Sem
    -- DEFAULT — um INSERT sem `value` explícito é erro, não a linha vazia
    -- que a invariante proíbe. `false` fica FORA da proibição de propósito:
    -- é o valor legítimo de uma fórmula booleana (checkbox mapeia false ->
    -- apaga a linha, e isso é do `normalize()` do spec em TS, não daqui).
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (record_id, property_id),
    CHECK (json_valid(value)),
    CHECK (
        json(value) <> 'null' AND json(value) <> '""'
        AND json(value) <> '[]' AND json(value) <> '{}'
    ),
    -- I5 (arquitetura §2): data é ISO de largura fixa, sem fuso. Dirigido
    -- pela FORMA do valor (só entra em jogo para um objeto com `start`),
    -- nunca por `property_type` — a Fase 6 acrescenta tipo sem tocar em
    -- migração. Regex `~` do Postgres não existe em SQLite; `GLOB` com
    -- classe de caractere expressa o mesmo formato fixo sem precisar de
    -- extensão nenhuma. Verificado contra data bem-formada, mal-formada,
    -- com e sem hora, com e sem `end`.
    CHECK (
        json_type(value) <> 'object'
        OR json_extract(value, '$.start') IS NULL
        OR (
            (json_extract(value, '$.start') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
             OR json_extract(value, '$.start') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]')
            AND (json_extract(value, '$.end') IS NULL
                 OR json_extract(value, '$.end') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                 OR json_extract(value, '$.end') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]')
        )
    )
) STRICT;

CREATE INDEX idx_database_record_values_property_id ON database_record_values (property_id);

-- O GIN de 0009/0017 (containment jsonb com jsonb_path_ops) NÃO tem
-- equivalente direto em SQLite — ver `perdas`. Nenhum índice substituto é
-- criado aqui: um índice que finge ajudar sem de fato acelerar containment
-- é pior que nenhum, porque engana quem decide otimizar depois.

CREATE TRIGGER database_record_values_set_updated_at
AFTER UPDATE ON database_record_values
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE database_record_values SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE record_id = NEW.record_id AND property_id = NEW.property_id;
END;
