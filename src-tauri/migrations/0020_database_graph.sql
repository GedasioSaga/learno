-- Template de database (DBS-103..107), config da database, e o grafo de
-- dependência entre registros (DBS-119) — que é também o que a view Trilha
-- desenha como flechas (TRL-003).

-- DBS-103: um template é uma página com esta marca. Não é tabela nova porque
-- um template PRECISA ser uma página: ele tem corpo de blocos para replicar
-- (DBS-105) e valores de propriedade para pré-preencher (DBS-104), e os dois
-- já são o que uma página-registro é.
ALTER TABLE pages ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;

-- Um template nunca aparece como registro comum na view: o índice de janela
-- de 0017 já filtra por `deleted_at IS NULL`, e quem consulta registros
-- filtra também por `is_template = 0`. Índice parcial próprio para a lista
-- de templates de uma database, que é consulta pequena e frequente (o
-- dropdown do botão New).
CREATE INDEX idx_pages_templates ON pages (database_id, position)
    WHERE is_template = 1 AND deleted_at IS NULL;

-- Config da database inteira: sub-itens ligados (DBS-118), dependências
-- ligadas (DBS-119), template padrão (DBS-107). Blob JSON porque é sempre
-- lido e escrito inteiro, e nenhuma consulta olha dentro dele — a mesma
-- razão pela qual a config de uma view é blob (decisão (d) da fundação).
ALTER TABLE databases ADD COLUMN config TEXT NOT NULL DEFAULT '{}';

-- DBS-119: "B bloqueada por A". É também a aresta que a Trilha desenha
-- (TRL-003), e é por isso que ela é uma tabela e não um valor de
-- propriedade: a Trilha precisa ler o grafo INTEIRO de uma database numa
-- consulta só para calcular os níveis topológicos (TRL-002), e um N+1 aqui
-- mataria a view.
CREATE TABLE database_record_dependencies (
    blocked_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    blocking_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (blocked_id, blocking_id),
    -- Auto-dependência é o ciclo de tamanho 1, e é o único que o banco
    -- consegue barrar sozinho. Ciclo maior (A→B→C→A) é detectado no Rust,
    -- por um helper compartilhado com a cascata de fórmula — ver TRL-005.
    CHECK (blocked_id <> blocking_id)
) STRICT;

-- A PK já cobre "quem bloqueia B?"; este cobre a direção inversa, "o que a
-- conclusão de A desbloqueia?", que é a pergunta que TRL-006 faz a cada
-- mudança de status.
CREATE INDEX idx_dependencies_blocking ON database_record_dependencies (blocking_id);
