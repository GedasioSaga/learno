-- Fase 3, peça N2. A ÚNICA exceção à decisão (c) da fundação (arquitetura
-- §5): a aresta de relação mora numa tabela dedicada, nunca dentro de
-- `database_record_values`. DDL idêntico ao verificado em
-- `docs/FASE-3-SCHEMA.sql` §0018.

-- O VÍNCULO como linha de primeira classe. Mão dupla são DUAS linhas de
-- database_properties sobre UMA aresta, e essas duas linhas precisam
-- CONCORDAR sobre simetria e cardinalidade. Uma tabela é o que torna
-- "concordar" impossível de errar; os mesmos fatos duplicados em dois blobs
-- `config` divergem na primeira edição de um lado.
CREATE TABLE database_relations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_database_id UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    target_database_id UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    is_symmetric BOOLEAN NOT NULL DEFAULT false,      -- DBS-088
    source_max_targets INTEGER,                        -- DBS-090; NULL = N:N
    target_max_sources INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT symmetric_only_on_self_relation
        CHECK (NOT is_symmetric OR source_database_id = target_database_id),
    CONSTRAINT positive_cardinality
        CHECK ((source_max_targets IS NULL OR source_max_targets > 0)
           AND (target_max_sources IS NULL OR target_max_sources > 0))
);
CREATE INDEX idx_database_relations_source ON database_relations (source_database_id);
CREATE INDEX idx_database_relations_target ON database_relations (target_database_id);
CREATE TRIGGER database_relations_set_updated_at BEFORE UPDATE ON database_relations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A ARESTA. Quatro razões medidas para não ser lista de uuid em jsonb:
--  1. RECÍPROCO 0,29 ms pelo índice reverso contra 9,33 ms por contenção
--     jsonb (26x), e roda uma vez por invalidação de rollup — milhares de
--     vezes por sessão da Fase 4.
--  2. INTEGRIDADE: target_record_id é FK. Uma lista jsonb pode apontar para
--     um uuid que nunca existiu, e 0016 já teve que se defender disso com
--     regex de uuid dentro de um gatilho.
--  3. LIXEIRA DE GRAÇA: deleted_at vive na página, não na aresta.
--  4. TOGGLE mão-única<->dupla sem reescrever 50.000 arrays do lado alvo.
-- Honestamente: na LEITURA direta de um viewport as duas formas empatam
-- (13,1 ms contra 13,5 ms). O argumento é integridade, lixeira, toggle e
-- custo por invalidação — não velocidade de leitura.
CREATE TABLE database_relation_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    relation_id UUID NOT NULL REFERENCES database_relations(id) ON DELETE CASCADE,
    source_record_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_record_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    -- Um índice fracionário POR EXTREMO: a mesma aresta é o item 3 na coluna
    -- de origem e o item 17 na recíproca, e essas ordens são independentes.
    -- Um `position` único quebraria DBS-088, onde os dois extremos são a
    -- MESMA coluna.
    source_position TEXT NOT NULL,
    target_position TEXT NOT NULL,
    -- Denormalizado de database_relations porque um CHECK não lê outra
    -- tabela. Reescrito para o conjunto inteiro na única transação que
    -- inverte a simetria — operação de esquema que já reorienta as arestas.
    is_symmetric BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- DBS-088 imposto pelo Postgres em vez de por cada escritor lembrar:
    -- aresta simétrica sempre com o menor uuid na origem, então (X,Y) e
    -- (Y,X) são LITERALMENTE a mesma linha e o UNIQUE recusa a espelho.
    -- Efeito colateral aceito: um registro não se relaciona consigo mesmo
    -- numa relação simétrica.
    CONSTRAINT symmetric_is_normalised
        CHECK (NOT is_symmetric OR source_record_id < target_record_id),
    UNIQUE (relation_id, source_record_id, target_record_id)
);

-- "O que este registro aponta", já na ordem certa, sem passo de sort.
CREATE INDEX idx_relation_edges_forward
    ON database_relation_edges (relation_id, source_record_id, source_position);
-- "Quem aponta para este registro": a coluna recíproca (DBS-087), a outra
-- metade da simétrica (DBS-088) e o fan-out de invalidação de rollup.
CREATE INDEX idx_relation_edges_reverse
    ON database_relation_edges (relation_id, target_record_id, target_position);

-- Cascata "apagar UMA propriedade de mão dupla -> vira mão única; apagar a
-- ÚLTIMA -> apaga relação e arestas" (arquitetura §5). Um gatilho, e não
-- disciplina de quem chama DELETE em database_properties, pela mesma razão
-- que 0016_block_page_links.sql já documenta para backlinks: essa tabela
-- não tem um único arquivo dono do jeito que database_record_values tem
-- (I4) — um comando genérico de "apagar propriedade" escrito por OUTRA
-- peça pode emitir esse DELETE sem saber que a linha era uma relação, e a
-- cascata ainda precisa acontecer. `WHEN (OLD.property_type = 'relation')`
-- custa zero para as outras 12+ famílias de propriedade: a condição é
-- avaliada pelo próprio gatilho, sem sequer invocar a função para elas.
--
-- O padrão de validar com regex antes de fazer CAST para uuid (em vez de
-- confiar cegamente no jsonb) é o mesmo de sync_block_page_links() em
-- 0016_block_page_links.sql — um config corrompido ou de tipo de
-- propriedade legado nunca deve poder abortar o DELETE que disparou isto.
CREATE FUNCTION cleanup_orphaned_relation() RETURNS trigger AS $$
DECLARE
    raw_relation_id TEXT := OLD.config ->> 'relationId';
    the_relation_id UUID;
    remaining INTEGER;
BEGIN
    IF raw_relation_id IS NULL
       OR raw_relation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;
    the_relation_id := raw_relation_id::uuid;

    SELECT count(*) INTO remaining
    FROM database_properties
    WHERE property_type = 'relation' AND config ->> 'relationId' = raw_relation_id;

    -- Zero propriedades restantes referenciando esta relação: a coluna que a
    -- mostrava não existe mais em NENHUMA das duas databases, então a
    -- relação e suas arestas (ON DELETE CASCADE) deixam de ter razão de
    -- existir. Uma restando é o caso "mão dupla virou mão única": nada além
    -- do DELETE que já aconteceu precisa acontecer.
    IF remaining = 0 THEN
        DELETE FROM database_relations WHERE id = the_relation_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER database_properties_cleanup_relation
    AFTER DELETE ON database_properties
    FOR EACH ROW WHEN (OLD.property_type = 'relation')
    EXECUTE FUNCTION cleanup_orphaned_relation();
