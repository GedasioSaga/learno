-- Fase 5 mind map: nodes carry their own free-form (x, y) canvas position —
-- unrelated to the sibling-ordering `position` used elsewhere — since a mind
-- map is a spatial layout, not an ordered list.
CREATE TABLE mindmaps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mindmaps_page_id ON mindmaps (page_id);

CREATE TRIGGER mindmaps_set_updated_at
    BEFORE UPDATE ON mindmaps
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE mindmap_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mindmap_id UUID NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    position_x DOUBLE PRECISION NOT NULL DEFAULT 0,
    position_y DOUBLE PRECISION NOT NULL DEFAULT 0,
    color TEXT,
    shape TEXT,
    icon TEXT,
    collapsed BOOLEAN NOT NULL DEFAULT false,
    -- Optional cross-navigation link from a node to a page — independent of
    -- the mind map's own visual layout above.
    page_ref_id UUID REFERENCES pages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mindmap_nodes_mindmap_id ON mindmap_nodes (mindmap_id);

CREATE TRIGGER mindmap_nodes_set_updated_at
    BEFORE UPDATE ON mindmap_nodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE mindmap_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mindmap_id UUID NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
    source_node_id UUID NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
    target_node_id UUID NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
    label TEXT,
    style JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source_node_id <> target_node_id)
);

CREATE INDEX idx_mindmap_edges_mindmap_id ON mindmap_edges (mindmap_id);
CREATE INDEX idx_mindmap_edges_source ON mindmap_edges (source_node_id);
CREATE INDEX idx_mindmap_edges_target ON mindmap_edges (target_node_id);
