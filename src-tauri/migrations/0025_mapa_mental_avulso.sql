-- Fase 5, correção: mapa mental existe SOZINHO — é uma seção própria do app,
-- no mesmo nível de Notas e Cartões, não uma coisa presa a uma página. Prender
-- um mapa a uma página continua possível (mapa dentro de uma categoria), mas
-- a página vira um VÍNCULO OPCIONAL, não um requisito.
--
-- `0013_mindmap.sql` declarou `mindmaps.page_id TEXT NOT NULL`. O contrato de
-- IPC (`create_mindmap(name, pageId: Option<Uuid>)`) sempre permitiu
-- `pageId: None`, e o repositório recusava esse caso com um erro explicando o
-- descompasso — o clique em "+ Novo mapa" sem página nenhuma escolhida
-- morria em silêncio na UI. Esta migração remove o `NOT NULL`; a leitura e a
-- escrita de `page_id` opcional ficam em `src/db/mindmap.rs`.
--
-- SQLite não tem `ALTER TABLE ... ALTER COLUMN`, então tirar um `NOT NULL`
-- exige reconstruir a tabela — o procedimento de 12 passos da documentação
-- oficial do SQLite para "Making Other Kinds Of Table Schema Changes"
-- (https://www.sqlite.org/lang_altertable.html). O passo 1 daquele
-- procedimento manda desligar `PRAGMA foreign_keys` ANTES de abrir a
-- transação: sem isso, `DROP TABLE` de uma tabela que ainda é referenciada
-- por FK de outra (aqui, `mindmaps` é referenciada por
-- `mindmap_nodes.mindmap_id` e por `mindmap_edges.mindmap_id`, ambas
-- `ON DELETE CASCADE`) dispara um `DELETE FROM` implícito sobre a tabela
-- antes de derrubá-la — e esse `DELETE` implícito PROPAGA a cascata para os
-- filhos, apagando nós e arestas de todo mapa mental existente.
--
-- Esse é exatamente o caso aqui, e não dá pra desligar `PRAGMA foreign_keys`
-- de dentro deste arquivo: o `sqlx` (`sqlx-sqlite` 0.8.6, ver
-- `sqlx-sqlite-0.8.6/src/migrate.rs`) abre a transação (`tx.begin()`) ANTES
-- de executar o corpo da migração como um lote só, e `PRAGMA foreign_keys` é
-- um no-op dentro de uma transação já aberta (documentado pelo próprio
-- SQLite) — diferente do driver Postgres do sqlx, o driver SQLite não lê o
-- marcador `-- no-transaction` para pular esse `BEGIN` (conferido no código
-- fonte vendorizado: só `sqlx-postgres` consulta `migration.no_tx`).
--
-- Verificado por um probe descartável fora deste repositório (Rust +
-- rusqlite, replicando a mesma hierarquia mindmaps -> mindmap_nodes ->
-- mindmap_edges dentro de uma transação com `foreign_keys = ON` o tempo
-- todo, exatamente como o sqlx roda esta migração): `DROP TABLE` de uma
-- tabela ainda referenciada apaga os filhos em cascata; a mesma sequência
-- reordenada para derrubar sempre o FILHO antes do PAI preserva todas as
-- linhas.
--
-- A segurança real deste arquivo não vem de `PRAGMA foreign_keys` (é
-- no-op aqui, por isso nem aparece abaixo — incluí-lo sem efeito enganaria
-- quem ler depois) — vem da ORDEM: cada tabela é copiada para uma tabela de
-- backup SEM constraint nenhuma (`CREATE TABLE ... AS SELECT` nunca copia
-- FK/CHECK/STRICT, só linhas), depois as três tabelas são derrubadas
-- FILHO-PRIMEIRO (edges, depois nodes, depois mindmaps — na hora de cada
-- `DROP`, nada mais na base aponta para a tabela caindo, então o `DELETE`
-- implícito não tem cascata nenhuma para propagar), e por fim recriadas
-- PAI-PRIMEIRO (mindmaps, depois nodes, depois edges — cada `CREATE TABLE`
-- só referencia o que já existe) com os dados restaurados a partir do
-- backup. `mindmap_nodes` e `mindmap_edges` voltam com o schema IDÊNTICO ao
-- de `0013_mindmap.sql`; só `mindmaps.page_id` muda, de `NOT NULL` para
-- opcional.

CREATE TABLE mindmaps_backup_0025 AS
    SELECT id, page_id, name, created_at, updated_at FROM mindmaps;

CREATE TABLE mindmap_nodes_backup_0025 AS
    SELECT id, mindmap_id, label, position_x, position_y, color, shape, icon, collapsed, page_ref_id,
           created_at, updated_at
    FROM mindmap_nodes;

CREATE TABLE mindmap_edges_backup_0025 AS
    SELECT id, mindmap_id, source_node_id, target_node_id, label, style, created_at FROM mindmap_edges;

-- Filho primeiro: na hora de cada DROP, a tabela seguinte da lista ainda não
-- foi tocada, então nada aponta mais para a que está caindo.
DROP TABLE mindmap_edges;
DROP TABLE mindmap_nodes;
DROP TABLE mindmaps;

-- Pai primeiro, agora com `page_id` opcional — o único ponto que de fato
-- muda em relação a `0013_mindmap.sql`.
CREATE TABLE mindmaps (
    id TEXT PRIMARY KEY NOT NULL,
    page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO mindmaps (id, page_id, name, created_at, updated_at)
    SELECT id, page_id, name, created_at, updated_at FROM mindmaps_backup_0025;

DROP TABLE mindmaps_backup_0025;

CREATE INDEX idx_mindmaps_page_id ON mindmaps (page_id);

CREATE TRIGGER mindmaps_set_updated_at
AFTER UPDATE ON mindmaps
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE mindmaps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- `mindmap_nodes`: schema idêntico ao de `0013_mindmap.sql`. Só existe aqui
-- porque precisou sair do caminho do DROP de `mindmaps` acima.
CREATE TABLE mindmap_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    mindmap_id TEXT NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    position_x REAL NOT NULL DEFAULT 0,
    position_y REAL NOT NULL DEFAULT 0,
    color TEXT,
    shape TEXT,
    icon TEXT,
    collapsed INTEGER NOT NULL DEFAULT 0,
    page_ref_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO mindmap_nodes (id, mindmap_id, label, position_x, position_y, color, shape, icon, collapsed,
                            page_ref_id, created_at, updated_at)
    SELECT id, mindmap_id, label, position_x, position_y, color, shape, icon, collapsed, page_ref_id,
           created_at, updated_at
    FROM mindmap_nodes_backup_0025;

DROP TABLE mindmap_nodes_backup_0025;

CREATE INDEX idx_mindmap_nodes_mindmap_id ON mindmap_nodes (mindmap_id);

CREATE TRIGGER mindmap_nodes_set_updated_at
AFTER UPDATE ON mindmap_nodes
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE mindmap_nodes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- `mindmap_edges`: schema idêntico ao de `0013_mindmap.sql`.
CREATE TABLE mindmap_edges (
    id TEXT PRIMARY KEY NOT NULL,
    mindmap_id TEXT NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
    source_node_id TEXT NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
    label TEXT,
    style TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (source_node_id <> target_node_id),
    CHECK (json_valid(style))
) STRICT;

INSERT INTO mindmap_edges (id, mindmap_id, source_node_id, target_node_id, label, style, created_at)
    SELECT id, mindmap_id, source_node_id, target_node_id, label, style, created_at
    FROM mindmap_edges_backup_0025;

DROP TABLE mindmap_edges_backup_0025;

CREATE INDEX idx_mindmap_edges_mindmap_id ON mindmap_edges (mindmap_id);
CREATE INDEX idx_mindmap_edges_source ON mindmap_edges (source_node_id);
CREATE INDEX idx_mindmap_edges_target ON mindmap_edges (target_node_id);
