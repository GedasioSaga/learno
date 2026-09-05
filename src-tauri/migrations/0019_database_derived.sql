-- O que um valor derivado (fórmula, rollup) depende, e a fila única que
-- recalcula os que ficaram sujos.

-- DBS-023/102: de que relação e de que propriedade-alvo um rollup agrega.
-- Saber isso por tabela, e não por leitura do `config` de cada propriedade,
-- é o que permite responder "quais rollups uma mudança nesta propriedade
-- suja?" por índice em vez de varrer o `config` de todas.
CREATE TABLE rollup_dependencies (
    rollup_property_id TEXT PRIMARY KEY REFERENCES database_properties(id) ON DELETE CASCADE,
    relation_id TEXT REFERENCES database_relations(id) ON DELETE CASCADE,
    -- NULL quando o rollup só olha as páginas (Count all não tem alvo).
    target_property_id TEXT REFERENCES database_properties(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_rollup_dependencies_target ON rollup_dependencies (target_property_id);
CREATE INDEX idx_rollup_dependencies_relation ON rollup_dependencies (relation_id);

-- A FILA ÚNICA de derivados — fórmula e rollup entram na MESMA, porque um
-- rollup pode alimentar uma fórmula (DBS-102) e duas filas separadas não
-- teriam como ordenar isso entre si.
--
-- A PRIMARY KEY (record_id, property_id) NÃO é higiene: é o mecanismo que
-- colapsa uma rajada. O caso é da Fase 4 e é real — um baralho relacionado a
-- 50.000 cards tem UM rollup que depende de todos; revisar os 50.000
-- sujaria esse par 50.000 vezes, e cada recálculo agregaria 50.000 alvos.
-- Com a PK, a rajada vira UMA linha e o recálculo acontece uma vez por
-- drenagem. Medido na versão Postgres: 2.000 UPDATEs produziram 2.003 pares
-- enfileirados, não 8.000.
--
-- Quem trocar esta PK por um id sequencial ressuscita o caso quadrático em
-- silêncio, e o sintoma só aparece com um baralho grande.
CREATE TABLE derived_value_queue (
    record_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    property_id TEXT NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
    enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (record_id, property_id)
) STRICT;

CREATE INDEX idx_derived_value_queue_property ON derived_value_queue (property_id);
CREATE INDEX idx_derived_value_queue_enqueued ON derived_value_queue (enqueued_at);

-- Os gatilhos que ENFILEIRAM ficaram de fora desta migração, e isso é
-- decisão, não esquecimento: quem suja um derivado é o caminho único de
-- escrita de valor (`db/record_values.rs`, invariante I4), que já enfileira
-- na mesma transação e conhece o grafo de dependência em memória. Um gatilho
-- SQL teria que redescobrir esse grafo a cada linha escrita, e SQLite não
-- tem gatilho de statement para fazê-lo uma vez por lote.
--
-- Isso é o oposto da decisão de `0016`/`0018`, onde o gatilho é o certo — e
-- a diferença é qual garantia importa em cada caso. Lá, o risco é um
-- caminho de escrita esquecer de sincronizar, e existem vários caminhos.
-- Aqui existe UM caminho por construção, e o risco é de custo, não de
-- esquecimento.
