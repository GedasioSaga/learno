-- Fase 3, peça N2. DBS-121 — automações de database. DDL idêntico ao
-- verificado em `docs/FASE-3-SCHEMA.sql` §0021.

-- Tabela, e não mais um blob em databases.config, porque last_run_at é
-- escrito a cada disparo de cadência e as automações são consultadas POR
-- TIPO DE GATILHO a cada escrita de valor — os dois padrões que um blob
-- lido-e-escrito-inteiro serve mal.
CREATE TABLE database_automations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    database_id UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    -- { "kind": "propertyChangedTo", "propertyId": uuid, "value": <jsonb> }
    -- { "kind": "pageAdded" }
    -- { "kind": "cadence", "every": "hourly"|"daily"|"weekly"|"monthly" }
    -- "changed TO x" exige valor antigo <> x E novo = x — não só "novo = x",
    -- senão regravar o mesmo valor redispara e alimenta laço.
    trigger JSONB NOT NULL,
    -- Um RecordEffect. Referencia propriedade por ID e guarda o nome só como
    -- snapshot de exibição: renomear NÃO quebra (ver divergência DBS-117).
    effect JSONB NOT NULL,
    -- Espelha o last_cadence_backup_at de backup::schedule::is_due, que já
    -- existe e já é testado. Catch-up ÚNICO na abertura do app: a senha do
    -- Postgres da Fase 1 NUNCA toca o disco, então nenhum processo de fundo
    -- consegue sequer ABRIR o banco. "A cada dia" significa "a cada dia em
    -- que o app for aberto", e isso precisa aparecer na UI, não só aqui.
    last_run_at TIMESTAMPTZ,
    position TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_database_automations_database_id
  ON database_automations (database_id, position);
-- O caminho quente: a cada escrita de valor, "quais automações ativas desta
-- database observam mudança de propriedade?". Parcial para não carregar as
-- desabilitadas.
CREATE INDEX idx_database_automations_enabled
  ON database_automations (database_id, (trigger ->> 'kind')) WHERE is_enabled;
CREATE TRIGGER database_automations_set_updated_at BEFORE UPDATE ON database_automations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
