-- =====================================================================
-- DDL CONSOLIDADO DA FASE 3 — cinco migracoes, numeradas pelo sintetizador.
-- Os cinco desenhos reservaram "0017" cada um; numeracao e recurso
-- compartilhado e colide EM SILENCIO entre worktrees.
--
-- Sem tabela repetida entre frentes: o indice (property_id, value) aparecia
-- em TRES desenhos, a derived_value_queue em dois, e o read model foi
-- construido, medido e recusado (nota ao final).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0017_database_value_invariants.sql
-- ---------------------------------------------------------------------

-- (1) CHAVE PRIMARIA NATURAL. Medido em 716.733 linhas: a PK sintetica
-- custa 34 MB duplicando a informacao do UNIQUE que 0009 ja cria, mais 16
-- bytes por linha na heap. Nenhum codigo referencia um valor pelo id
-- proprio. A tabela esta VAZIA hoje — barato agora, caro depois.
ALTER TABLE database_record_values DROP CONSTRAINT database_record_values_pkey;
ALTER TABLE database_record_values DROP COLUMN id;
ALTER TABLE database_record_values ADD PRIMARY KEY (record_id, property_id);
DROP INDEX idx_database_record_values_record_id;  -- virou prefixo da PK

-- (2) VAZIO E A AUSENCIA DA LINHA (I1). O DEFAULT 'null' de 0009
-- contradiz a invariante: sai junto, senao um INSERT sem `value` cria
-- exatamente a linha vazia que a invariante proibe.
-- `false` fica FORA da proibicao de proposito: e valor legitimo de uma
-- formula booleana. Checkbox mapeia false -> apaga, e isso e do
-- normalize() do spec, provado por teste que afirma ZERO linhas.
ALTER TABLE database_record_values ALTER COLUMN value DROP DEFAULT;
ALTER TABLE database_record_values ADD CONSTRAINT chk_drv_never_empty CHECK (
  value <> 'null'::jsonb AND value <> '""'::jsonb
  AND value <> '[]'::jsonb AND value <> '{}'::jsonb
);

-- (3) AS CHAVES DE ORDENACAO — o enxerto que sustenta a fase.
-- Dirigidas pela FORMA do jsonb, nunca pelo property_type: assim a Fase 6
-- acrescenta tipo sem tocar em migracao.
--
-- O left(...,256) NAO e precaucao. Medido:
--   INSERT ... to_jsonb(<6 KB de md5 concatenado>)
--   ERROR: index row size 6448 exceeds btree version 4 maximum 2704
-- ou seja, a gravacao FALHA na primeira vez que alguem cola um paragrafo
-- numa celula. E a armadilha: repeat('x',100000) PASSA, porque o btree
-- comprime antes de medir — um teste com texto repetitivo fica verde sobre
-- um indice que quebra o app. O fixture usa md5 concatenado.
ALTER TABLE database_record_values
  ADD COLUMN sort_num NUMERIC GENERATED ALWAYS AS (
    CASE jsonb_typeof(value)
      WHEN 'number'  THEN (value #>> '{}')::numeric
      WHEN 'boolean' THEN CASE WHEN value = 'true'::jsonb THEN 1 ELSE 0 END
      ELSE NULL
    END
  ) STORED,
  ADD COLUMN sort_text TEXT GENERATED ALWAYS AS (
    left(CASE
      WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}'
      WHEN jsonb_typeof(value) = 'object'
        THEN COALESCE(value ->> 'start', value ->> 'text')
      WHEN jsonb_typeof(value) = 'array' AND jsonb_typeof(value -> 0) = 'string'
        THEN value #>> '{0}'
      ELSE NULL
    END, 256)
  ) STORED,
  -- Instante em que ESTE valor calculado pode mudar sozinho pela passagem
  -- do tempo (formula que le now()/today()). NULL = nunca, o caso de
  -- praticamente toda linha. A varredura preguicosa le esta coluna e
  -- ENFILEIRA na fila unica de 0019 — nao e um segundo mecanismo.
  ADD COLUMN stale_after TIMESTAMPTZ;

-- Indices COMPLETOS, nao parciais, de proposito. A versao parcial e menor e
-- igualmente rapida, MAS o planejador so a usa se a query carregar
-- "AND sort_text IS NOT NULL" — e sem esse predicado a query devolve AS
-- MESMAS LINHAS 20x mais devagar. Nenhuma assercao de resultado pegaria.
-- `record_id` no fim e o que permite Index Only Scan (Heap Fetches: 0).
-- Medido: 42 MB e 40 MB para 716.733 linhas.
CREATE INDEX idx_drv_sort_num  ON database_record_values (property_id, sort_num,  record_id);
CREATE INDEX idx_drv_sort_text ON database_record_values (property_id, sort_text, record_id);

CREATE INDEX idx_drv_stale_after ON database_record_values (stale_after)
  WHERE stale_after IS NOT NULL;

-- (4) O GIN DE 0009 SAI. Dois arquitetos mediram, independentemente, que o
-- planejador NAO o escolhe em nenhuma consulta real — nem na igualdade de
-- select, onde deveria brilhar. Indice que o planejador nao escolhe e custo
-- puro de disco e de escrita. O combinado serve o unico caso que precisa
-- mesmo de GIN (contains de multi-select): 20 ms -> 5,9 ms.
DROP INDEX idx_database_record_values_value;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE INDEX idx_drv_property_value_gin
  ON database_record_values USING GIN (property_id, value jsonb_path_ops);

-- (5) A FORMA DA DATA (I5), imposta pelo banco e nao por convencao.
-- Largura fixa e zero-padding sao o que fazem a ordenacao lexicografica SER
-- a cronologica. Dirigido pela forma: so vale para objeto com 'start'.
ALTER TABLE database_record_values ADD CONSTRAINT chk_drv_iso_date_shape CHECK (
  jsonb_typeof(value) <> 'object'
  OR value -> 'start' IS NULL
  OR (
    (value ->> 'start') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2})?$'
    AND (value -> 'end' IS NULL
         OR (value ->> 'end') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2})?$')
  )
);

-- (6) DBS-026 ESTA QUEBRADO NA FUNDACAO: um UPDATE em
-- database_record_values deixa pages.updated_at byte a byte igual, entao
-- "Editado em" nunca se move. Row-level e nao statement-level porque foi
-- medido mais rapido (209 ms contra 302 ms num varrimento de 8.739 linhas).
--
-- O interruptor e um GUC de TRANSACAO, nao "ALTER TABLE ... DISABLE
-- TRIGGER": aquele pega lock e NAO e transacional, entao um import que
-- falhe no meio deixa o gatilho desligado para o app inteiro, e o sintoma e
-- "Editado em parou de funcionar" sem nada apontando para o import.
-- Caminho de massa faz SET LOCAL learno.bulk_load = 'on' e um
-- UPDATE pages SET updated_at = now() unico no fim.
CREATE OR REPLACE FUNCTION touch_record_from_value() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('learno.bulk_load', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;
  UPDATE pages SET updated_at = now() WHERE id = COALESCE(NEW.record_id, OLD.record_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drv_touch_record
  AFTER INSERT OR UPDATE OR DELETE ON database_record_values
  FOR EACH ROW EXECUTE FUNCTION touch_record_from_value();

-- (7) data_version: invalida o token da consulta em duas fases. Sem ele,
-- editar uma celula e rolar serviria a ordem antiga sem sintoma nenhum.
-- Statement-level para que um lote de 20 edicoes nao dispute 20 vezes a
-- mesma linha de `databases`.
ALTER TABLE databases ADD COLUMN data_version BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bump_database_data_version() RETURNS trigger AS $$
BEGIN
  UPDATE databases d SET data_version = d.data_version + 1
  WHERE d.id IN (SELECT DISTINCT p.database_id FROM pages p
                 JOIN changed c ON c.record_id = p.id
                 WHERE p.database_id IS NOT NULL);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drv_bump_version_ins AFTER INSERT ON database_record_values
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT
  EXECUTE FUNCTION bump_database_data_version();
CREATE TRIGGER drv_bump_version_upd AFTER UPDATE ON database_record_values
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT
  EXECUTE FUNCTION bump_database_data_version();
CREATE TRIGGER drv_bump_version_del AFTER DELETE ON database_record_values
  REFERENCING OLD TABLE AS changed FOR EACH STATEMENT
  EXECUTE FUNCTION bump_database_data_version();

-- (8) O indice que toda janela de view usa, incluindo sub-itens (DBS-118) e
-- o "AND NOT is_template" de 0020. idx_pages_database_id (0007) cobre so
-- database_id e deixa a ordenacao por conta do executor.
CREATE INDEX idx_pages_database_records
  ON pages (database_id, parent_id, position)
  WHERE database_id IS NOT NULL AND deleted_at IS NULL;


-- ---------------------------------------------------------------------
-- 0018_database_relations.sql
-- A UNICA excecao a decisao (c) da fundacao.
-- ---------------------------------------------------------------------

-- O VINCULO como linha de primeira classe. Mao dupla sao DUAS linhas de
-- database_properties sobre UMA aresta, e essas duas linhas precisam
-- CONCORDAR sobre simetria e cardinalidade. Uma tabela e o que torna
-- "concordar" impossivel de errar; os mesmos fatos duplicados em dois blobs
-- `config` divergem na primeira edicao de um lado.
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

-- A ARESTA. Quatro razoes medidas para nao ser lista de uuid em jsonb:
--  1. RECIPROCO 0,29 ms pelo indice reverso contra 9,33 ms por contencao
--     jsonb (26x), e roda uma vez por invalidacao de rollup — milhares de
--     vezes por sessao da Fase 4.
--  2. INTEGRIDADE: target_record_id e FK. Uma lista jsonb pode apontar para
--     um uuid que nunca existiu, e 0016 ja teve que se defender disso com
--     regex de uuid dentro de um gatilho.
--  3. LIXEIRA DE GRACA: deleted_at vive na pagina, nao na aresta.
--  4. TOGGLE mao-unica<->dupla sem reescrever 50.000 arrays do lado alvo.
-- Honestamente: na LEITURA direta de um viewport as duas formas empatam
-- (13,1 ms contra 13,5 ms). O argumento e integridade, lixeira, toggle e
-- custo por invalidacao — nao velocidade de leitura.
CREATE TABLE database_relation_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    relation_id UUID NOT NULL REFERENCES database_relations(id) ON DELETE CASCADE,
    source_record_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_record_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    -- Um indice fracionario POR EXTREMO: a mesma aresta e o item 3 na coluna
    -- de origem e o item 17 na reciproca, e essas ordens sao independentes.
    -- Um `position` unico quebraria DBS-088, onde os dois extremos sao a
    -- MESMA coluna.
    source_position TEXT NOT NULL,
    target_position TEXT NOT NULL,
    -- Denormalizado de database_relations porque um CHECK nao le outra
    -- tabela. Reescrito para o conjunto inteiro na unica transacao que
    -- inverte a simetria — operacao de esquema que ja reorienta as arestas.
    is_symmetric BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- DBS-088 imposto pelo Postgres em vez de por cada escritor lembrar:
    -- aresta simetrica sempre com o menor uuid na origem, entao (X,Y) e
    -- (Y,X) sao LITERALMENTE a mesma linha e o UNIQUE recusa a espelho.
    -- Efeito colateral aceito: um registro nao se relaciona consigo mesmo
    -- numa relacao simetrica.
    CONSTRAINT symmetric_is_normalised
        CHECK (NOT is_symmetric OR source_record_id < target_record_id),
    UNIQUE (relation_id, source_record_id, target_record_id)
);

-- "O que este registro aponta", ja na ordem certa, sem passo de sort.
CREATE INDEX idx_relation_edges_forward
    ON database_relation_edges (relation_id, source_record_id, source_position);
-- "Quem aponta para este registro": a coluna reciproca (DBS-087), a outra
-- metade da simetrica (DBS-088) e o fan-out de invalidacao de rollup.
CREATE INDEX idx_relation_edges_reverse
    ON database_relation_edges (relation_id, target_record_id, target_position);


-- ---------------------------------------------------------------------
-- 0019_database_derived.sql — UMA fila para formula E rollup
-- ---------------------------------------------------------------------

-- Projecao do config de cada rollup, mantida por gatilho a partir do proprio
-- config (nunca escrita a mao, para nao poder divergir do que espelha).
-- Existe por uma razao so: o gatilho na tabela quente precisa responder
-- "esta propriedade alimenta algum rollup?" por indice, em microssegundos,
-- sem varrer database_properties nem entrar em jsonb.
CREATE TABLE rollup_dependencies (
    rollup_property_id UUID PRIMARY KEY REFERENCES database_properties(id) ON DELETE CASCADE,
    relation_id UUID REFERENCES database_relations(id) ON DELETE CASCADE,
    -- NULL quando o rollup so olha as paginas (Count all nao tem alvo).
    target_property_id UUID REFERENCES database_properties(id) ON DELETE SET NULL
);
CREATE INDEX idx_rollup_dependencies_target ON rollup_dependencies (target_property_id);
CREATE INDEX idx_rollup_dependencies_relation ON rollup_dependencies (relation_id);

-- O CONJUNTO SUJO — UMA fila para formula E rollup. Dois mecanismos de
-- invalidacao com ordem indefinida entre si quebrariam DBS-102 (formula
-- sobre rollup) e DBS-084 (formula sobre formula), que exigem cascata
-- ORDENADA. O stale_after de 0017 nao e um segundo mecanismo: a varredura
-- preguicosa le aquela coluna e INSERE aqui. Um drenador so, uma ordem
-- topologica so.
--
-- LOGGED de proposito, apesar de UNLOGGED ser mais rapido: invalidacao
-- perdida num crash e numero silenciosamente errado para sempre, e a Fase 4
-- conta cards a vencer por rollup.
--
-- A PRIMARY KEY (record_id, property_id) NAO e higiene, e o MECANISMO DE
-- ESCALA: um lote de 50.000 revisoes que sujam o MESMO rollup de deck
-- colapsa numa unica linha, e o recalculo acontece uma vez por drenagem em
-- vez de 50.000 vezes. Medido: 2.000 UPDATEs produziram 2.003 pares, nao
-- 8.000. Quem trocar por um id sequencial ressuscita o caso quadratico da
-- Fase 4 em silencio. Esta fila NUNCA pode virar log append-only.
CREATE TABLE derived_value_queue (
    record_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES database_properties(id) ON DELETE CASCADE,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (record_id, property_id)
);
CREATE INDEX idx_derived_value_queue_property ON derived_value_queue (property_id);
CREATE INDEX idx_derived_value_queue_enqueued ON derived_value_queue (enqueued_at);

-- Cinco gatilhos, UMA responsabilidade: alcancabilidade de grafo, que e o
-- que SQL faz bem. Nenhum sabe o que "median" significa — a semantica de
-- agregacao fica inteira no kernel Rust puro (src/rollup/), testavel sem
-- cluster e reusado verbatim pelo rodape DBS-058/130.
--
--  T1 AFTER INSERT OR DELETE ON database_relation_edges
--     -> enfileira os rollups dos DOIS extremos. Dispara tambem quando a
--        aresta morre por FK CASCADE da exclusao permanente de uma pagina —
--        comportamento a PROVAR apagando uma PAGINA, nunca fabricando o
--        DELETE da aresta a mao (seria o falso-verde do db_backlinks.rs).
--  T2 AFTER INSERT OR UPDATE OF value ON database_record_values
--     -> junta rollup_dependencies por target_property_id e enfileira, pelo
--        indice reverso, todo registro-fonte alcancado. Custo medido: +10%
--        no caminho quente (~5 us por linha), identico quando a propriedade
--        nao alimenta rollup nenhum — o curto-circuito por indice funciona.
--  T3 AFTER UPDATE OF deleted_at ON pages
--     -> lixeira e restauracao mudam o conjunto agregado sem mudar aresta.
--  T4 AFTER INSERT OR UPDATE OF config ON database_properties
--     -> reprojeta rollup_dependencies; enfileira a database quando a funcao
--        ou a propriedade alvo do rollup muda.
--  T5 AFTER DELETE ON database_properties / database_relations
--     -> marca `config` das sobreviventes com `broken` em vez de apagar a
--        coluna do usuario (apagar destruiria layout, largura e ordenacao —
--        dano irreversivel, porque a lixeira e de pagina, nao de coluna).


-- ---------------------------------------------------------------------
-- 0020_database_graph.sql — templates, sub-itens, dependencias
-- ---------------------------------------------------------------------

-- DBS-103..107: um template E um registro (pagina com database_id), so que
-- invisivel nas views. Uma coluna booleana entra no MESMO predicado que toda
-- query de view ja tem (deleted_at IS NULL) e cabe no mesmo indice parcial —
-- contra o anti-join NOT EXISTS que uma tabela `database_templates` custaria
-- sobre 50.000 registros. O NOME do template e o titulo da pagina (literal
-- do DBS-103). CUIDADO: toda query de view precisa do "AND NOT is_template";
-- esquecer faz o template aparecer como registro fantasma.
ALTER TABLE pages ADD COLUMN is_template BOOLEAN NOT NULL DEFAULT false;

-- Configuracao de nivel de database, que nao existe hoje. Blob pela MESMA
-- razao que database_views.config e um: sempre lido e escrito inteiro, nunca
-- consultado por sub-campo — e absorve configuracao futura sem uma migracao
-- por toggle. Forma esperada:
--   { "subItems": { "enabled": bool },
--     "dependencies": { "enabled": bool,
--                       "shiftMode": "none"|"whenOverlap"|"maintainGap",
--                       "avoidWeekends": bool, "datePropertyId": uuid|null },
--     "defaultTemplateId": uuid|null }
-- O default por VIEW (que ganha deste) mora em database_views.config.
-- Nenhum id aqui tem FK: por isso o validador de referencias quebradas
-- (DBS-117) cobre template padrao, nao so botao.
ALTER TABLE databases ADD COLUMN config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- DBS-119: "B bloqueada por A". Tabela propria e NAO instancia da
-- auto-relacao de DBS-088: uma aresta de database_relation_edges e exposta
-- como PROPRIEDADE — vai ao painel de propriedades, ao seletor de colunas,
-- ao CSV, e e alvo de rollup. Dependencia nao e nada disso; e metadado de
-- agendamento. Reusar obrigaria um sinalizador "relacao de sistema" em cinco
-- superficies de UI, e a primeira que esquecesse vazaria dependencias para o
-- seletor de relacao do usuario. As duas listas de adjacencia usam o MESMO
-- helper de deteccao de ciclo (db::graph::detect_cycle).
CREATE TABLE database_record_dependencies (
    blocked_id  UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    blocking_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocked_id, blocking_id),
    CONSTRAINT chk_dependency_not_self CHECK (blocked_id <> blocking_id)
);
-- A PK cobre "quem bloqueia B?"; este cobre a direcao inversa, que e a que a
-- cascata de deslocamento percorre ("A mudou, quem depende de A?").
CREATE INDEX idx_dependencies_blocking ON database_record_dependencies (blocking_id);


-- ---------------------------------------------------------------------
-- 0021_database_automations.sql — DBS-121
-- ---------------------------------------------------------------------

-- Tabela, e nao mais um blob em databases.config, porque last_run_at e
-- escrito a cada disparo de cadencia e as automacoes sao consultadas POR
-- TIPO DE GATILHO a cada escrita de valor — os dois padroes que um blob
-- lido-e-escrito-inteiro serve mal.
CREATE TABLE database_automations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    database_id UUID NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    -- { "kind": "propertyChangedTo", "propertyId": uuid, "value": <jsonb> }
    -- { "kind": "pageAdded" }
    -- { "kind": "cadence", "every": "hourly"|"daily"|"weekly"|"monthly" }
    -- "changed TO x" exige valor antigo <> x E novo = x — nao so novo = x,
    -- senao regravar o mesmo valor redispara e alimenta laco.
    trigger JSONB NOT NULL,
    -- Um RecordEffect. Referencia propriedade por ID e guarda o nome so como
    -- snapshot de exibicao: renomear NAO quebra (ver divergencia DBS-117).
    effect JSONB NOT NULL,
    -- Espelha o last_cadence_backup_at de backup::schedule::is_due, que ja
    -- existe e ja e testado. Catch-up UNICO na abertura do app: a senha do
    -- Postgres da Fase 1 NUNCA toca o disco, entao nenhum processo de fundo
    -- consegue sequer ABRIR o banco. "A cada dia" significa "a cada dia em
    -- que o app for aberto", e isso precisa aparecer na UI, nao so aqui.
    last_run_at TIMESTAMPTZ,
    position TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_database_automations_database_id
  ON database_automations (database_id, position);
-- O caminho quente: a cada escrita de valor, "quais automacoes ativas desta
-- database observam mudanca de propriedade?". Parcial para nao carregar as
-- desabilitadas.
CREATE INDEX idx_database_automations_enabled
  ON database_automations (database_id, (trigger ->> 'kind')) WHERE is_enabled;
CREATE TRIGGER database_automations_set_updated_at BEFORE UPDATE ON database_automations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- NOTA DELIBERADA: NAO EXISTE `database_record_index`.
--
-- O read model foi construido e medido lado a lado com o EAV sobre os
-- MESMOS 50.000 registros x 15 propriedades (716.733 linhas):
--   filtro 3 condicoes + ordenacao + 1a pagina : read model 19 ms / EAV 49 ms
--   cabecalhos de grupo, SEM filtro            : read model 25 ms / EAV  5 ms
--   hidratar 50 registros x 15 propriedades    : read model 0,34 ms / EAV 1,2 ms
--   janela sem filtro                          : read model 0,29 ms / EAV 0,09 ms
--   custo                                      : +45 MB heap, 2 gatilhos
--
-- Ganha uma, PERDE outra por 5x, empata nas duas que acontecem por frame
-- (as duas muito abaixo de um orcamento de 16 ms), e cobra uma SEGUNDA
-- FONTE DE VERDADE — o modo de falha que ACHADOS-FASE-2 documenta tres
-- vezes. Os ~30 ms que ele compra sao pagos UMA vez por mudanca de
-- configuracao sob a consulta em duas fases, nao por frame.
--
-- A recusa e REVERSIVEL: se a Fase 4 provar que dói, o read model volta como
-- estrutura ADITIVA, nao como reescrita.
-- =====================================================================