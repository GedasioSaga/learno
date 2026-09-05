-- DBS-022/086/087/088/090: a aresta de relação, a ÚNICA exceção à decisão de
-- que todo valor de propriedade é linha em `database_record_values`.
--
-- Ela ganha tabela própria porque três coisas que um valor em JSON não dá:
-- responder "quem aponta para este registro" sem varrer todos os valores,
-- integridade referencial de verdade (uma aresta para um registro apagado
-- deixa de existir sozinha), e um índice para cada direção da leitura.
CREATE TABLE database_relations (
    id TEXT PRIMARY KEY NOT NULL,
    source_database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    target_database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    -- DBS-088: auto-relação simétrica, uma coluna só, em que vincular X a Y
    -- faz Y mostrar X na MESMA coluna.
    is_symmetric INTEGER NOT NULL DEFAULT 0 CHECK (is_symmetric IN (0, 1)),
    -- DBS-090: NULL = N:N; 1 = "1 page".
    source_max_targets INTEGER,
    target_max_sources INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Simetria só faz sentido quando a database se relaciona consigo mesma.
    CHECK (is_symmetric = 0 OR source_database_id = target_database_id),
    CHECK ((source_max_targets IS NULL OR source_max_targets > 0)
       AND (target_max_sources IS NULL OR target_max_sources > 0))
) STRICT;

CREATE INDEX idx_database_relations_source ON database_relations (source_database_id);
CREATE INDEX idx_database_relations_target ON database_relations (target_database_id);

-- `updated_at` automático: SQLite não tem função compartilhada, então cada
-- tabela declara o próprio, com a guarda `WHEN` que impede a segunda passada
-- de recursar (ver `0002_updated_at_trigger.sql`).
CREATE TRIGGER database_relations_set_updated_at
AFTER UPDATE ON database_relations
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE database_relations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TABLE database_relation_edges (
    id TEXT PRIMARY KEY NOT NULL,
    relation_id TEXT NOT NULL REFERENCES database_relations(id) ON DELETE CASCADE,
    source_record_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_record_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    -- Um índice fracionário POR EXTREMO: a mesma aresta é o item 3 na coluna
    -- de um lado e o item 7 na do outro, e reordenar um lado não pode mexer
    -- na ordem do outro.
    source_position TEXT NOT NULL,
    target_position TEXT NOT NULL,
    is_symmetric INTEGER NOT NULL DEFAULT 0 CHECK (is_symmetric IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- A forma canônica de uma aresta simétrica: sempre gravada com o menor
    -- id na origem. É o que impede X→Y e Y→X coexistirem como duas arestas
    -- e a coluna única de DBS-088 mostrar o vínculo duplicado.
    CHECK (is_symmetric = 0 OR source_record_id < target_record_id),
    UNIQUE (relation_id, source_record_id, target_record_id)
) STRICT;

CREATE INDEX idx_relation_edges_forward
    ON database_relation_edges (relation_id, source_record_id, source_position);
CREATE INDEX idx_relation_edges_reverse
    ON database_relation_edges (relation_id, target_record_id, target_position);

-- Apagar a última propriedade que exibia uma relação apaga a relação (e, por
-- cascata, suas arestas): a coluna não existe mais em NENHUMA das duas
-- databases, então a relação deixou de ter razão de ser.
--
-- Na versão Postgres isto era uma função plpgsql de 33 linhas com variáveis,
-- `IF`, e um filtro por regex de UUID. Aqui é um DELETE condicional, e as
-- duas complicações somem:
--
-- - o regex existia para `raw_relation_id::uuid` não estourar num valor que
--   não fosse UUID; aqui `database_relations.id` é TEXT e a comparação é
--   TEXT com TEXT, que não pode falhar — um valor estranho simplesmente não
--   casa nenhuma linha;
-- - o `SELECT count(*) INTO remaining; IF remaining = 0` vira o
--   `NOT EXISTS` do próprio DELETE.
--
-- `docs/MIGRACAO-SQLITE.md` previa mover esta lógica para o Rust por não
-- haver plpgsql. Ficou aqui de propósito, e é melhor: pelo mesmo argumento
-- de `0016_block_page_links.sql`, um gatilho roda não importa qual caminho
-- de código apaga a propriedade, e N chamadores lembrando de chamar uma
-- função de limpeza são N lugares que podem esquecer — sem falhar alto.
CREATE TRIGGER database_properties_cleanup_relation
AFTER DELETE ON database_properties
WHEN OLD.property_type = 'relation' AND json_extract(OLD.config, '$.relationId') IS NOT NULL
BEGIN
    DELETE FROM database_relations
    WHERE id = json_extract(OLD.config, '$.relationId')
      AND NOT EXISTS (
          SELECT 1 FROM database_properties
          WHERE property_type = 'relation'
            AND json_extract(config, '$.relationId') = json_extract(OLD.config, '$.relationId')
      );
END;
