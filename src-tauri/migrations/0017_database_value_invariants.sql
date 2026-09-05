-- As invariantes de valor da Fase 3 (arquitetura §2). Na versão Postgres esta
-- migração era grande: refazia a chave primária de `database_record_values`,
-- acrescentava o CHECK de vazio e o de forma de data, criava as colunas
-- geradas de ordenação e os gatilhos.
--
-- Em SQLite ela encolheu, e o motivo é uma limitação real do banco: o
-- `ALTER TABLE` do SQLite só faz RENAME, ADD COLUMN e DROP COLUMN — não
-- existe `ADD CONSTRAINT`, `DROP CONSTRAINT` nem `ALTER COLUMN`. Refazer a
-- chave primária de uma tabela existente exigiria o ritual de criar tabela
-- nova, copiar, apagar e renomear.
--
-- Em vez disso, o que era estrutura da tabela foi para a criação dela, em
-- `0009_database_record_values.sql`: a PK `(record_id, property_id)`, a
-- ausência da coluna `id`, o CHECK de vazio (I1) e o CHECK de forma de data
-- (I5) nascem lá. Isso é legítimo porque não existe banco de usuário nenhum
-- ainda — nenhuma instalação precisa da migração incremental. Se um dia
-- precisar, o ritual de tabela-nova-copia-renomeia é o caminho.
--
-- O que sobrou aqui é o que o `ALTER TABLE` do SQLite de fato sabe fazer:
-- acrescentar coluna (inclusive coluna GERADA, desde que VIRTUAL) e criar
-- índice e gatilho.

-- (1) As colunas de ordenação — I2 (arquitetura §2): NUNCA se ordena por
-- `value`. O motivo é verificável e não é teórico: jsonb/JSON comparam
-- objeto pela QUANTIDADE DE CHAVES antes do conteúdo, então
-- `{"start":"2026-01-01","end":"2026-01-02"}` ordena DEPOIS de
-- `{"start":"2026-02-01"}` — uma database só-dia passa em todo teste e
-- quebra no dia em que alguém liga "End date".
--
-- VIRTUAL, não STORED, por duas razões que se somam: o `ALTER TABLE` do
-- SQLite recusa acrescentar coluna gerada STORED (aceita VIRTUAL), e coluna
-- virtual não ocupa disco. SQLite indexa coluna virtual normalmente — medido
-- neste projeto com 750.000 linhas, com o índice sendo de fato usado pelo
-- plano (ver `docs/FASE-3-MEDICOES.md`).
--
-- `json_type(value)` devolve 'integer'/'real' para número e 'true'/'false'
-- para booleano — não existe um 'number'/'boolean' único como no
-- `jsonb_typeof` do Postgres.
ALTER TABLE database_record_values ADD COLUMN sort_num REAL GENERATED ALWAYS AS (
  CASE json_type(value)
    WHEN 'integer' THEN CAST(value AS REAL)
    WHEN 'real'    THEN CAST(value AS REAL)
    WHEN 'true'    THEN 1.0
    WHEN 'false'   THEN 0.0
    ELSE NULL
  END
) VIRTUAL;

-- I3 (arquitetura §2): `sort_text` é TRUNCADO em 256. Isso não é economia —
-- é o que impede a gravação de falhar. Um btree tem teto de tamanho de linha
-- de índice, e um texto de alta entropia acima de ~2,7 KB estoura o índice e
-- o INSERT falha. A armadilha é que o teste ingênuo passa: 100.000
-- caracteres REPETIDOS comprimem e cabem; 6 KB de prosa real não. Por isso
-- toda condição sobre `sort_text` sai EM PAR com a mesma condição sobre
-- `value` — a primeira é a condição de índice, a segunda restaura a exatidão
-- para o texto que passou de 256.
ALTER TABLE database_record_values ADD COLUMN sort_text TEXT GENERATED ALWAYS AS (
  substr(
    CASE
      WHEN json_type(value) = 'text'   THEN json_extract(value, '$')
      WHEN json_type(value) = 'object' THEN COALESCE(json_extract(value, '$.start'), json_extract(value, '$.text'))
      WHEN json_type(value) = 'array' AND json_type(value, '$[0]') = 'text' THEN json_extract(value, '$[0]')
      ELSE NULL
    END,
    1, 256
  )
) VIRTUAL;

-- Quando um valor derivado de relógio (`now()`, `today()`) deixa de valer.
-- Coluna comum, escrita pelo avaliador de fórmula — não gerada, porque
-- depende da expressão avaliada e não do valor guardado.
ALTER TABLE database_record_values ADD COLUMN stale_after TEXT;

-- (2) Os índices de ordenação e filtro. `record_id` no fim de cada um os
-- torna cobertos para a fase 1 da consulta em duas fases (resolver a lista
-- ordenada de ids sem tocar a tabela).
CREATE INDEX idx_drv_sort_num  ON database_record_values (property_id, sort_num,  record_id);
CREATE INDEX idx_drv_sort_text ON database_record_values (property_id, sort_text, record_id);

-- Parcial: só as linhas que de fato têm vencimento entram, e a varredura de
-- revalidação por relógio lê só elas.
CREATE INDEX idx_drv_stale_after ON database_record_values (stale_after) WHERE stale_after IS NOT NULL;

-- O índice GIN `jsonb_path_ops` que a versão Postgres criava aqui NÃO tem
-- equivalente e não faz falta: ele já era peso morto lá. Medido — nos quatro
-- planos com predicado de igualdade, que é a forma natural de um filtro de
-- view, o planejador nunca o usou, porque `jsonb_path_ops` atende
-- containment (`@>`) e não `=`. Quem filtra passa pelas colunas geradas
-- acima. Ver `docs/FASE-3-MEDICOES.md`.

-- (3) DBS-026: editar QUALQUER propriedade atualiza o "Editado em" do
-- registro. Três gatilhos porque SQLite não tem
-- `AFTER INSERT OR UPDATE OR DELETE` numa declaração só.
--
-- O interruptor de carga em lote era, na versão Postgres, um GUC de
-- transação (`current_setting('learno.bulk_load')`) lido pelo corpo plpgsql.
-- SQLite não tem GUC nem corpo procedural: o modo de carga em lote passa a
-- ser um campo do repositório em `db/record_values.rs`, que é o caminho
-- ÚNICO de escrita (invariante I4) e portanto o único lugar que precisaria
-- suprimi-lo. Ver `docs/MIGRACAO-SQLITE.md`.
CREATE TRIGGER drv_touch_record_after_insert
AFTER INSERT ON database_record_values
BEGIN
    UPDATE pages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.record_id;
END;

CREATE TRIGGER drv_touch_record_after_update
AFTER UPDATE ON database_record_values
BEGIN
    UPDATE pages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.record_id;
END;

CREATE TRIGGER drv_touch_record_after_delete
AFTER DELETE ON database_record_values
BEGIN
    UPDATE pages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.record_id;
END;

-- (4) `data_version` invalida o token da consulta em duas fases. Sem ele,
-- editar uma célula e rolar serviria a ordem antiga sem sintoma nenhum.
ALTER TABLE databases ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0;

-- O incremento NÃO é gatilho aqui, e essa é a diferença mais importante
-- desta migração em relação à versão Postgres. Lá eram três gatilhos de
-- STATEMENT com `REFERENCING NEW TABLE`, para um lote de 20 edições disputar
-- a linha de `databases` uma vez só em vez de vinte. SQLite não tem gatilho
-- de statement nem transition table: um gatilho FOR EACH ROW faria as vinte
-- disputas, que é justamente o que o desenho evitava.
--
-- Então o incremento vira uma linha em `apply_record_value_changes`
-- (`db/record_values.rs`), na mesma transação do lote — uma vez por lote, que
-- é o comportamento original. Isso é seguro exatamente porque a invariante
-- I4 garante que não existe outro escritor desta tabela, e existe um teste
-- que roda `rg` e falha se alguém abrir um segundo caminho de escrita.

-- (5) A janela de registros de uma database, ordenada por posição, é a
-- consulta que abre toda view — merece índice próprio.
CREATE INDEX idx_pages_database_records ON pages (database_id, position)
    WHERE database_id IS NOT NULL AND deleted_at IS NULL;
