-- Fase 3, peça N2. UMA fila para fórmula E rollup (arquitetura §4/§8). DDL
-- idêntico ao verificado em `docs/FASE-3-SCHEMA.sql` §0019. Os cinco
-- gatilhos que alimentam esta fila a partir de `database_relation_edges`,
-- `database_record_values`, `pages.deleted_at` e `database_properties.config`
-- são construídos pela peça dona do motor de fórmula/rollup (fora do escopo
-- de N2) — este arquivo só estabelece a tabela e a documentação de contrato
-- que aquela peça implementa contra.

-- Projeção do config de cada rollup, mantida por gatilho a partir do próprio
-- config (nunca escrita a mão, para não poder divergir do que espelha).
-- Existe por uma razão só: o gatilho na tabela quente precisa responder
-- "esta propriedade alimenta algum rollup?" por índice, em microssegundos,
-- sem varrer database_properties nem entrar em jsonb.
CREATE TABLE rollup_dependencies (
    rollup_property_id UUID PRIMARY KEY REFERENCES database_properties(id) ON DELETE CASCADE,
    relation_id UUID REFERENCES database_relations(id) ON DELETE CASCADE,
    -- NULL quando o rollup só olha as páginas (Count all não tem alvo).
    target_property_id UUID REFERENCES database_properties(id) ON DELETE SET NULL
);
CREATE INDEX idx_rollup_dependencies_target ON rollup_dependencies (target_property_id);
CREATE INDEX idx_rollup_dependencies_relation ON rollup_dependencies (relation_id);

-- O CONJUNTO SUJO — UMA fila para fórmula E rollup. Dois mecanismos de
-- invalidação com ordem indefinida entre si quebrariam DBS-102 (fórmula
-- sobre rollup) e DBS-084 (fórmula sobre fórmula), que exigem cascata
-- ORDENADA. O stale_after de 0017 não é um segundo mecanismo: a varredura
-- preguiçosa lê aquela coluna e INSERE aqui. Um drenador só, uma ordem
-- topológica só.
--
-- LOGGED de propósito, apesar de UNLOGGED ser mais rápido: invalidação
-- perdida num crash é número silenciosamente errado para sempre, e a Fase 4
-- conta cards a vencer por rollup.
--
-- A PRIMARY KEY (record_id, property_id) NÃO é higiene, e o MECANISMO DE
-- ESCALA: um lote de 50.000 revisões que sujam o MESMO rollup de deck
-- colapsa numa única linha, e o recálculo acontece uma vez por drenagem em
-- vez de 50.000 vezes. Medido: 2.000 UPDATEs produziram 2.003 pares, não
-- 8.000. Quem trocar por um id sequencial ressuscita o caso quadrático da
-- Fase 4 em silêncio. Esta fila NUNCA pode virar log append-only.
CREATE TABLE derived_value_queue (
    record_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (record_id, property_id)
);
CREATE INDEX idx_derived_value_queue_property ON derived_value_queue (property_id);
CREATE INDEX idx_derived_value_queue_enqueued ON derived_value_queue (enqueued_at);

-- Cinco gatilhos, UMA responsabilidade: alcançabilidade de grafo, que é o
-- que SQL faz bem. Nenhum sabe o que "median" significa — a semântica de
-- agregação fica inteira no kernel Rust puro (src/rollup/), testável sem
-- cluster e reusado verbatim pelo rodapé DBS-058/130.
--
--  T1 AFTER INSERT OR DELETE ON database_relation_edges
--     -> enfileira os rollups dos DOIS extremos. Dispara também quando a
--        aresta morre por FK CASCADE da exclusão permanente de uma página —
--        comportamento a PROVAR apagando uma PÁGINA, nunca fabricando o
--        DELETE da aresta a mão (seria o falso-verde do db_backlinks.rs).
--  T2 AFTER INSERT OR UPDATE OF value ON database_record_values
--     -> junta rollup_dependencies por target_property_id e enfileira, pelo
--        índice reverso, todo registro-fonte alcançado. Custo medido: +10%
--        no caminho quente (~5 us por linha), idêntico quando a propriedade
--        não alimenta rollup nenhum — o curto-circuito por índice funciona.
--  T3 AFTER UPDATE OF deleted_at ON pages
--     -> lixeira e restauração mudam o conjunto agregado sem mudar aresta.
--  T4 AFTER INSERT OR UPDATE OF config ON database_properties
--     -> reprojeta rollup_dependencies; enfileira a database quando a função
--        ou a propriedade alvo do rollup muda.
--  T5 AFTER DELETE ON database_properties / database_relations
--     -> marca `config` das sobreviventes com `broken` em vez de apagar a
--        coluna do usuário (apagar destruiria layout, largura e ordenação —
--        dano irreversível, porque a lixeira é de página, não de coluna).
--
-- Nenhum dos cinco é criado por esta migração: pertencem à peça que possui
-- o motor de fórmula/rollup (F7/D1, fora da pasta exclusiva de N2). Ver
-- `divergencias_da_arquitetura` no relatório desta peça.
