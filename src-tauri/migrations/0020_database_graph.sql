-- Fase 3, peça N2. Templates, config de nível de database e dependências
-- entre registros (arquitetura §7/§11 "grafo"). DDL idêntico ao verificado
-- em `docs/FASE-3-SCHEMA.sql` §0020.

-- DBS-103..107: um template É um registro (página com database_id), só que
-- invisível nas views. Uma coluna booleana entra no MESMO predicado que toda
-- query de view já tem (deleted_at IS NULL) e cabe no mesmo índice parcial —
-- contra o anti-join NOT EXISTS que uma tabela `database_templates` custaria
-- sobre 50.000 registros. O NOME do template é o título da página (literal
-- do DBS-103). CUIDADO: toda query de view precisa do "AND NOT is_template";
-- esquecer faz o template aparecer como registro fantasma.
ALTER TABLE pages ADD COLUMN is_template BOOLEAN NOT NULL DEFAULT false;

-- Configuração de nível de database, que não existe hoje. Blob pela MESMA
-- razão que database_views.config é um: sempre lido e escrito inteiro, nunca
-- consultado por sub-campo — e absorve configuração futura sem uma migração
-- por toggle. Forma esperada:
--   { "subItems": { "enabled": bool },
--     "dependencies": { "enabled": bool,
--                       "shiftMode": "none"|"whenOverlap"|"maintainGap",
--                       "avoidWeekends": bool, "datePropertyId": uuid|null },
--     "defaultTemplateId": uuid|null }
-- O default por VIEW (que ganha deste) mora em database_views.config.
-- Nenhum id aqui tem FK: por isso o validador de referências quebradas
-- (DBS-117) cobre template padrão, não só botão.
ALTER TABLE databases ADD COLUMN config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- DBS-119: "B bloqueada por A". Tabela própria e NÃO instância da
-- auto-relação de DBS-088: uma aresta de database_relation_edges é exposta
-- como PROPRIEDADE — vai ao painel de propriedades, ao seletor de colunas,
-- ao CSV, e é alvo de rollup. Dependência não é nada disso; é metadado de
-- agendamento. Reusar obrigaria um sinalizador "relação de sistema" em cinco
-- superfícies de UI, e a primeira que esquecesse vazaria dependências para o
-- seletor de relação do usuário. As duas listas de adjacência usam o MESMO
-- helper de detecção de ciclo (db::graph::detect_cycle).
CREATE TABLE database_record_dependencies (
    blocked_id  UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    blocking_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocked_id, blocking_id),
    CONSTRAINT chk_dependency_not_self CHECK (blocked_id <> blocking_id)
);
-- A PK cobre "quem bloqueia B?"; este cobre a direção inversa, que é a que a
-- cascata de deslocamento percorre ("A mudou, quem depende de A?").
CREATE INDEX idx_dependencies_blocking ON database_record_dependencies (blocking_id);
