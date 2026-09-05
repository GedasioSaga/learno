-- Fase 5 mind map: nodes carry their own free-form (x, y) canvas position —
-- unrelated to the sibling-ordering `position` used elsewhere — since a mind
-- map is a spatial layout, not an ordered list.
CREATE TABLE mindmaps (
    id TEXT PRIMARY KEY NOT NULL,
    page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX idx_mindmaps_page_id ON mindmaps (page_id);

CREATE TRIGGER mindmaps_set_updated_at
AFTER UPDATE ON mindmaps
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE mindmaps SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

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
    -- Optional cross-navigation link from a node to a page — independent of
    -- the mind map's own visual layout above.
    page_ref_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX idx_mindmap_nodes_mindmap_id ON mindmap_nodes (mindmap_id);

CREATE TRIGGER mindmap_nodes_set_updated_at
AFTER UPDATE ON mindmap_nodes
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE mindmap_nodes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

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

CREATE INDEX idx_mindmap_edges_mindmap_id ON mindmap_edges (mindmap_id);
CREATE INDEX idx_mindmap_edges_source ON mindmap_edges (source_node_id);
CREATE INDEX idx_mindmap_edges_target ON mindmap_edges (target_node_id);
