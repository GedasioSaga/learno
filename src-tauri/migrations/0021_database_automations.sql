-- DBS-121: o motor de regras da database. Gatilho e ação são descritos em
-- JSON porque a forma deles cresce a cada tipo de gatilho novo, e nenhuma
-- consulta filtra por dentro do efeito.
CREATE TABLE database_automations (
    id TEXT PRIMARY KEY NOT NULL,
    database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
    -- { "kind": "propertyChangedTo", "propertyId": <id>, "value": <json> }
    -- { "kind": "pageAdded" }
    -- { "kind": "cadence", "every": "hourly"|"daily"|"weekly"|"monthly" }
    --
    -- "mudou PARA x" exige valor antigo <> x E novo = x — não só "novo = x",
    -- senão regravar o mesmo valor redispara e alimenta laço.
    --
    -- `trigger` é palavra reservada em SQL: sempre entre aspas duplas aqui e
    -- em toda consulta que a leia.
    "trigger" TEXT NOT NULL,
    -- Um RecordEffect. Referencia propriedade por ID e guarda o nome só como
    -- instantâneo de exibição, então renomear a propriedade NÃO quebra o
    -- efeito — o que diverge do texto de DBS-117, que fala em avisar quando a
    -- propriedade é RENOMEADA. Com id, renomear é inofensivo e o aviso passa
    -- a valer para propriedade APAGADA. Divergência registrada, não silenciosa.
    effect TEXT NOT NULL,
    -- Espelha o `last_cadence_backup_at` de `backup::schedule::is_due`, que já
    -- existe e já é testado.
    --
    -- NOTA QUE MUDOU COM O SQLITE: a versão Postgres justificava o catch-up
    -- na abertura dizendo que "a senha do Postgres nunca toca o disco, então
    -- nenhum processo de fundo consegue sequer ABRIR o banco". Isso deixou de
    -- ser verdade — o banco agora é um arquivo, sem senha, e um processo de
    -- fundo poderia abri-lo. A decisão de fazer catch-up na abertura
    -- CONTINUA, mas o motivo agora é outro e mais simples: o app é desktop e
    -- não tem serviço rodando junto. "A cada dia" segue significando "a cada
    -- dia em que o app for aberto", e isso precisa aparecer na UI — senão o
    -- usuário espera uma automação que nunca dispara com o app fechado.
    last_run_at TEXT,
    position TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX idx_database_automations_database_id
  ON database_automations (database_id, position);

-- O caminho quente: a cada escrita de valor, "quais automações ativas desta
-- database observam mudança de propriedade?". Parcial para não carregar as
-- desabilitadas; `is_enabled` sozinho não é predicado válido em SQLite, que
-- não tem booleano, então vai comparado.
CREATE INDEX idx_database_automations_enabled
  ON database_automations (database_id, json_extract("trigger", '$.kind')) WHERE is_enabled = 1;

CREATE TRIGGER database_automations_set_updated_at
AFTER UPDATE ON database_automations
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE database_automations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
