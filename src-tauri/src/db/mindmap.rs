//! Repository for the mind map feature — Fase 5's `mindmaps`, `mindmap_nodes`
//! and `mindmap_edges` tables (`0013_mindmap.sql`, com `mindmaps.page_id`
//! tornado opcional por `0025_mapa_mental_avulso.sql`).
//!
//! Um mapa mental é uma árvore de posição LIVRE (cada nó carrega seu próprio
//! `(x, y)` de canvas), não uma lista ordenada — por isso este módulo não usa
//! `db::position` como `db::pages`/`db::blocks` usam para irmãos. A única
//! peça que espelha `db::blocks` de propósito é [`MindmapRepository::apply_changes`]:
//! o canvas (`@xyflow/react`) emite dezenas de mudanças por gesto de arrasto,
//! então um lote inteiro entra numa única transação, exatamente como
//! `BlockRepository::apply_changes` já resolve para o editor de blocos.
//!
//! Mapa mental é uma SEÇÃO PRÓPRIA do app, no mesmo nível de Notas e Cartões —
//! não pertence a uma página. Prender um mapa a uma página continua possível
//! (mapa dentro de uma categoria), mas isso é um vínculo opcional:
//! `page_id: Option<Uuid>` de ponta a ponta, do contrato de IPC até a coluna
//! (`0025_mapa_mental_avulso.sql`). Antes dessa migração, `mindmaps.page_id`
//! era `NOT NULL` e [`MindmapRepository::create`] recusava `None` — era essa
//! recusa silenciosa (a UI não mostrava nada) que fazia "+ Novo mapa" sem
//! página selecionada não criar nada.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindmapRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbIdOpt")]
    pub page_id: Option<Uuid>,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindmapNodeRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub mindmap_id: Uuid,
    pub label: String,
    pub position_x: f64,
    pub position_y: f64,
    pub color: Option<String>,
    pub shape: Option<String>,
    pub icon: Option<String>,
    /// Nome do arquivo dentro de `media/` (mesma convenção de
    /// `content.src` do editor de blocos — ver `media-storage.ts`), nunca
    /// um caminho absoluto. Coluna própria (`0032_mindmap_node_image.sql`),
    /// deliberadamente separada de `icon`: `icon` é um glifo de emoji
    /// curto, isto é um arquivo no disco — misturar os dois na mesma
    /// coluna daria ao mesmo dado dois significados sem como distinguir.
    pub image: Option<String>,
    pub collapsed: bool,
    #[sqlx(try_from = "DbIdOpt")]
    pub page_ref_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindmapEdgeRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub mindmap_id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub source_node_id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub target_node_id: Uuid,
    pub label: Option<String>,
    pub style: JsonValue,
    pub created_at: DateTime<Utc>,
}

/// `get_mindmap`/`apply_mindmap_changes`'s return shape: o mapa e todo o seu
/// grafo, de uma vez — o canvas resincroniza o estado inteiro depois de um
/// lote, em vez de reconciliar só as linhas que mudaram.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindmapGraph {
    pub mindmap: MindmapRow,
    pub nodes: Vec<MindmapNodeRow>,
    pub edges: Vec<MindmapEdgeRow>,
}

/// Entrada de `createNode`. `id: None` é o caminho de um importador ou de um
/// teste — o canvas real sempre manda o id que o nó já ganhou no cliente no
/// instante em que foi desenhado (mesmo motivo de `NewBlockInput::id`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMindmapNodeInput {
    #[serde(default)]
    pub id: Option<Uuid>,
    #[serde(default)]
    pub label: String,
    pub position_x: f64,
    pub position_y: f64,
    pub color: Option<String>,
    pub shape: Option<String>,
    pub icon: Option<String>,
    pub image: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    pub page_ref_id: Option<Uuid>,
}

/// Entrada de `updateNode`. Mesma convenção de `BlockPatchInput`: um campo
/// ausente (ou `null`) significa "sem mudança" — o `UPDATE` usa `COALESCE`
/// para preservar o valor atual. Consequência aceita dessa convenção: não há,
/// através deste patch, como LIMPAR um campo opcional (`color`, `pageRefId`)
/// de volta para `NULL` depois de ele já ter sido preenchido; isso exigiria
/// duplo-`Option` e nenhum outro patch deste projeto se dá a esse trabalho —
/// exceto `image` logo abaixo, que precisa mesmo de remover a imagem do
/// cartão como caso de uso de verdade, e por isso é o único campo aqui que
/// paga o preço do duplo-`Option`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindmapNodePatchInput {
    pub label: Option<String>,
    pub color: Option<String>,
    pub shape: Option<String>,
    pub icon: Option<String>,
    /// `image`, diferente de todo o resto deste patch, PRECISA distinguir
    /// "não mandado" de "mandado como null": trocar a imagem de um cartão é
    /// o caso comum, mas REMOVER a imagem (voltar a NULL) é um caso de uso
    /// de verdade daqui — o COALESCE de sempre nunca escreve `NULL` por
    /// cima de um valor existente, então ele sozinho não serve.
    /// `Option<Option<String>>` + `deserialize_some` é o idioma padrão do
    /// serde pra isso: campo ausente no JSON → `None` (fora) → "sem
    /// mudança"; campo `null` → `Some(None)` → "limpar"; campo com string →
    /// `Some(Some(..))` → "trocar". Ver `update_node_tx` para o `CASE WHEN`
    /// que lê esse terceiro estado (COALESCE não bastaria).
    #[serde(default, deserialize_with = "deserialize_some")]
    pub image: Option<Option<String>>,
    pub collapsed: Option<bool>,
    pub page_ref_id: Option<Uuid>,
}

/// Deserializador auxiliar de `MindmapNodePatchInput::image`: qualquer valor
/// PRESENTE no JSON (incluindo `null`) vira `Some(..)` — só a AUSÊNCIA do
/// campo (coberta pelo `#[serde(default)]` ao lado, que nunca chama esta
/// função) fica como `None`. É o que abre o terceiro estado que um
/// `Option<String>` sozinho não tem espaço para representar.
fn deserialize_some<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Entrada de `moveNode`: só a posição no canvas muda.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindmapNodePositionInput {
    pub position_x: f64,
    pub position_y: f64,
}

/// Entrada de `createEdge`. `style` fica com o mesmo default `'{}'` da
/// migração quando omitido.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMindmapEdgeInput {
    #[serde(default)]
    pub id: Option<Uuid>,
    pub source_node_id: Uuid,
    pub target_node_id: Uuid,
    pub label: Option<String>,
    #[serde(default)]
    pub style: Option<JsonValue>,
}

/// Entrada de `updateEdge` — mesma convenção de `MindmapNodePatchInput`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindmapEdgePatchInput {
    pub label: Option<String>,
    pub style: Option<JsonValue>,
}

/// Espelha `BlockChangeInput`'s tagged union: `rename_all = "camelCase"`
/// numa variante `PascalCase` de duas palavras vira exatamente as tags que o
/// contrato pede — `createNode`, `updateNode`, `moveNode`, `deleteNode`,
/// `createEdge`, `updateEdge`, `deleteEdge`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MindmapChangeInput {
    CreateNode { node: NewMindmapNodeInput },
    UpdateNode { id: Uuid, patch: MindmapNodePatchInput },
    MoveNode { id: Uuid, position: MindmapNodePositionInput },
    DeleteNode { id: Uuid },
    CreateEdge { edge: NewMindmapEdgeInput },
    UpdateEdge { id: Uuid, patch: MindmapEdgePatchInput },
    DeleteEdge { id: Uuid },
}

const NODE_COLUMNS: &str =
    "id, mindmap_id, label, position_x, position_y, color, shape, icon, image, collapsed, page_ref_id, created_at, updated_at";
const EDGE_COLUMNS: &str = "id, mindmap_id, source_node_id, target_node_id, label, style, created_at";

pub struct MindmapRepository {
    pool: SqlitePool,
}

impl MindmapRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Todo mapa mental, mais recentemente editado primeiro — não existe
    /// lixeira para mapa mental (a tabela não tem `deleted_at`; ver
    /// `delete`), então esta lista é sempre "tudo que existe".
    pub async fn list(&self) -> Result<Vec<MindmapRow>> {
        let rows = sqlx::query_as::<_, MindmapRow>(
            "SELECT id, page_id, name, created_at, updated_at FROM mindmaps ORDER BY updated_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// `page_id` é opcional de verdade (0025_mapa_mental_avulso.sql): um mapa
    /// mental avulso grava `NULL`, um mapa preso a uma categoria grava o id
    /// da página. `page_id.db()` (via `IdBind` para `Option<Uuid>`) liga
    /// `NULL` ou o TEXT canônico do id — nunca um `Uuid` cru (ver
    /// `db::ids`), então não há caminho para gravar BLOB numa coluna TEXT
    /// aqui.
    pub async fn create(&self, name: &str, page_id: Option<Uuid>) -> Result<MindmapRow> {
        let id = Uuid::now_v7();
        let row = sqlx::query_as::<_, MindmapRow>(
            "INSERT INTO mindmaps (id, page_id, name) VALUES ($1, $2, $3) \
             RETURNING id, page_id, name, created_at, updated_at",
        )
        .bind(id.db())
        .bind(page_id.db())
        .bind(name)
        .fetch_one(&self.pool)
        .await?;

        Ok(row)
    }

    pub async fn get(&self, id: Uuid) -> Result<MindmapRow> {
        sqlx::query_as::<_, MindmapRow>("SELECT id, page_id, name, created_at, updated_at FROM mindmaps WHERE id = $1")
            .bind(id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("mapa mental {id}")))
    }

    pub async fn rename(&self, id: Uuid, name: &str) -> Result<MindmapRow> {
        sqlx::query_as::<_, MindmapRow>(
            "UPDATE mindmaps SET name = $2 WHERE id = $1 RETURNING id, page_id, name, created_at, updated_at",
        )
        .bind(id.db())
        .bind(name)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| Error::NotFound(format!("mapa mental {id}")))
    }

    /// Exclusão definitiva, não soft-delete: `mindmaps` não tem coluna
    /// `deleted_at` em `0013_mindmap.sql` (diferente de `pages`), então não
    /// há um estado "na lixeira" para inventar aqui sem migração nova. Os
    /// nós e arestas do mapa somem junto por `ON DELETE CASCADE`
    /// (`mindmap_nodes.mindmap_id` / `mindmap_edges.mindmap_id`) — provado
    /// por efeito no teste de integração, não reimplementado aqui.
    pub async fn delete(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("DELETE FROM mindmaps WHERE id = $1").bind(id.db()).execute(&self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound(format!("mapa mental {id}")));
        }
        Ok(())
    }

    pub async fn get_graph(&self, id: Uuid) -> Result<MindmapGraph> {
        let mindmap = self.get(id).await?;

        let nodes_sql = format!("SELECT {NODE_COLUMNS} FROM mindmap_nodes WHERE mindmap_id = $1 ORDER BY created_at");
        let nodes = sqlx::query_as::<_, MindmapNodeRow>(&nodes_sql).bind(id.db()).fetch_all(&self.pool).await?;

        let edges_sql = format!("SELECT {EDGE_COLUMNS} FROM mindmap_edges WHERE mindmap_id = $1 ORDER BY created_at");
        let edges = sqlx::query_as::<_, MindmapEdgeRow>(&edges_sql).bind(id.db()).fetch_all(&self.pool).await?;

        Ok(MindmapGraph { mindmap, nodes, edges })
    }

    /// O endpoint de lote do canvas: aplica cada mudança, na ordem dada,
    /// dentro de uma única transação — um arrasto que emite dezenas de
    /// `moveNode` vira uma ida ao banco, não dezenas. Uma mudança que falha
    /// (ex.: `updateNode` de um id que um `deleteNode` anterior no MESMO
    /// lote já removeu) desfaz o lote inteiro, nunca deixa parte dele
    /// gravada — mesmo contrato de `BlockRepository::apply_changes`.
    pub async fn apply_changes(&self, mindmap_id: Uuid, changes: Vec<MindmapChangeInput>) -> Result<MindmapGraph> {
        let mut tx = self.pool.begin().await?;
        ensure_mindmap_exists_tx(&mut tx, mindmap_id).await?;

        for change in changes {
            match change {
                MindmapChangeInput::CreateNode { node } => create_node_tx(&mut tx, mindmap_id, node).await?,
                MindmapChangeInput::UpdateNode { id, patch } => update_node_tx(&mut tx, mindmap_id, id, &patch).await?,
                MindmapChangeInput::MoveNode { id, position } => move_node_tx(&mut tx, mindmap_id, id, position).await?,
                MindmapChangeInput::DeleteNode { id } => delete_node_tx(&mut tx, mindmap_id, id).await?,
                MindmapChangeInput::CreateEdge { edge } => create_edge_tx(&mut tx, mindmap_id, edge).await?,
                MindmapChangeInput::UpdateEdge { id, patch } => update_edge_tx(&mut tx, mindmap_id, id, &patch).await?,
                MindmapChangeInput::DeleteEdge { id } => delete_edge_tx(&mut tx, mindmap_id, id).await?,
            }
        }

        tx.commit().await?;
        self.get_graph(mindmap_id).await
    }
}

async fn ensure_mindmap_exists_tx(tx: &mut Transaction<'_, Sqlite>, id: Uuid) -> Result<()> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM mindmaps WHERE id = $1)")
        .bind(id.db())
        .fetch_one(&mut **tx)
        .await?;
    if !exists {
        return Err(Error::NotFound(format!("mapa mental {id}")));
    }
    Ok(())
}

async fn create_node_tx(tx: &mut Transaction<'_, Sqlite>, mindmap_id: Uuid, node: NewMindmapNodeInput) -> Result<()> {
    let id = node.id.unwrap_or_else(Uuid::now_v7);
    sqlx::query(
        "INSERT INTO mindmap_nodes (id, mindmap_id, label, position_x, position_y, color, shape, icon, image, collapsed, page_ref_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(id.db())
    .bind(mindmap_id.db())
    .bind(&node.label)
    .bind(node.position_x)
    .bind(node.position_y)
    .bind(&node.color)
    .bind(&node.shape)
    .bind(&node.icon)
    .bind(&node.image)
    .bind(node.collapsed)
    .bind(node.page_ref_id.db())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn update_node_tx(
    tx: &mut Transaction<'_, Sqlite>,
    mindmap_id: Uuid,
    id: Uuid,
    patch: &MindmapNodePatchInput,
) -> Result<()> {
    // `image` não pode entrar no COALESCE de cima: um patch que MANDA
    // `image: null` (limpar) precisa gravar `NULL` de propósito, e
    // `COALESCE($n, image)` nunca sobrescreve com `NULL` — ver o comentário
    // de `MindmapNodePatchInput::image`. `image_provided` diz se o campo
    // veio no patch (não importa o valor); `image_value` é o valor de fato
    // (pode ser `NULL` mesmo com `image_provided = true` — é exatamente o
    // caso "limpar"). Sem o `CASE`, um patch que não toca em `image`
    // (`image_provided = false`) apagaria a imagem existente.
    let image_provided = patch.image.is_some();
    let image_value: Option<String> = patch.image.clone().flatten();

    let result = sqlx::query(
        "UPDATE mindmap_nodes SET \
             label = COALESCE($3, label), \
             color = COALESCE($4, color), \
             shape = COALESCE($5, shape), \
             icon = COALESCE($6, icon), \
             collapsed = COALESCE($7, collapsed), \
             page_ref_id = COALESCE($8, page_ref_id), \
             image = CASE WHEN $9 THEN $10 ELSE image END \
         WHERE id = $1 AND mindmap_id = $2",
    )
    .bind(id.db())
    .bind(mindmap_id.db())
    .bind(&patch.label)
    .bind(&patch.color)
    .bind(&patch.shape)
    .bind(&patch.icon)
    .bind(patch.collapsed)
    .bind(patch.page_ref_id.db())
    .bind(image_provided)
    .bind(&image_value)
    .execute(&mut **tx)
    .await?;

    if result.rows_affected() == 0 {
        return Err(Error::NotFound(format!("nó {id} no mapa mental {mindmap_id}")));
    }
    Ok(())
}

async fn move_node_tx(
    tx: &mut Transaction<'_, Sqlite>,
    mindmap_id: Uuid,
    id: Uuid,
    position: MindmapNodePositionInput,
) -> Result<()> {
    let result = sqlx::query("UPDATE mindmap_nodes SET position_x = $3, position_y = $4 WHERE id = $1 AND mindmap_id = $2")
        .bind(id.db())
        .bind(mindmap_id.db())
        .bind(position.position_x)
        .bind(position.position_y)
        .execute(&mut **tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(Error::NotFound(format!("nó {id} no mapa mental {mindmap_id}")));
    }
    Ok(())
}

/// Apaga o nó. As arestas que o tinham como origem ou destino somem junto
/// por `ON DELETE CASCADE` (`0013_mindmap.sql`: `mindmap_edges.source_node_id`
/// e `.target_node_id` referenciam `mindmap_nodes(id) ON DELETE CASCADE`) —
/// nenhum `DELETE FROM mindmap_edges` extra é escrito aqui de propósito; ver
/// o teste `apagar_no_remove_arestas_que_o_tocam_via_cascata_da_fk` que prova
/// isso por efeito.
async fn delete_node_tx(tx: &mut Transaction<'_, Sqlite>, mindmap_id: Uuid, id: Uuid) -> Result<()> {
    let result = sqlx::query("DELETE FROM mindmap_nodes WHERE id = $1 AND mindmap_id = $2")
        .bind(id.db())
        .bind(mindmap_id.db())
        .execute(&mut **tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(Error::NotFound(format!("nó {id} no mapa mental {mindmap_id}")));
    }
    Ok(())
}

async fn create_edge_tx(tx: &mut Transaction<'_, Sqlite>, mindmap_id: Uuid, edge: NewMindmapEdgeInput) -> Result<()> {
    if edge.source_node_id == edge.target_node_id {
        // O `CHECK (source_node_id <> target_node_id)` da migração pegaria
        // isso de qualquer forma, mas como `Error::Database` opaco em vez de
        // uma mensagem que a UI possa mostrar — a mesma razão de validar
        // entrada de IPC antes de deixar o SQL cru reclamar.
        return Err(Error::Invalid("aresta não pode ligar um nó a si mesmo".into()));
    }

    // A checagem que este lote existe para fazer: uma aresta apontando para
    // nó de OUTRO mapa mental é corrupção silenciosa que nenhuma FK detecta
    // (a FK só garante que o nó existe em algum mapa, não que é ESTE mapa).
    ensure_nodes_belong_to_mindmap_tx(tx, mindmap_id, &[edge.source_node_id, edge.target_node_id]).await?;

    let id = edge.id.unwrap_or_else(Uuid::now_v7);
    let style = edge.style.unwrap_or_else(|| serde_json::json!({}));

    sqlx::query(
        "INSERT INTO mindmap_edges (id, mindmap_id, source_node_id, target_node_id, label, style) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id.db())
    .bind(mindmap_id.db())
    .bind(edge.source_node_id.db())
    .bind(edge.target_node_id.db())
    .bind(&edge.label)
    .bind(&style)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn update_edge_tx(
    tx: &mut Transaction<'_, Sqlite>,
    mindmap_id: Uuid,
    id: Uuid,
    patch: &MindmapEdgePatchInput,
) -> Result<()> {
    let result = sqlx::query(
        "UPDATE mindmap_edges SET label = COALESCE($3, label), style = COALESCE($4, style) \
         WHERE id = $1 AND mindmap_id = $2",
    )
    .bind(id.db())
    .bind(mindmap_id.db())
    .bind(&patch.label)
    .bind(&patch.style)
    .execute(&mut **tx)
    .await?;

    if result.rows_affected() == 0 {
        return Err(Error::NotFound(format!("aresta {id} no mapa mental {mindmap_id}")));
    }
    Ok(())
}

async fn delete_edge_tx(tx: &mut Transaction<'_, Sqlite>, mindmap_id: Uuid, id: Uuid) -> Result<()> {
    let result = sqlx::query("DELETE FROM mindmap_edges WHERE id = $1 AND mindmap_id = $2")
        .bind(id.db())
        .bind(mindmap_id.db())
        .execute(&mut **tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(Error::NotFound(format!("aresta {id} no mapa mental {mindmap_id}")));
    }
    Ok(())
}

/// Todo id em `node_ids` precisa ser um nó ativo de EXATAMENTE `mindmap_id` —
/// não só existir em algum mapa mental qualquer. É a barreira contra "aresta
/// que aponta para nó de outro mapa é corrupção".
async fn ensure_nodes_belong_to_mindmap_tx(
    tx: &mut Transaction<'_, Sqlite>,
    mindmap_id: Uuid,
    node_ids: &[Uuid],
) -> Result<()> {
    let unique_ids: Vec<Uuid> = node_ids.iter().copied().collect::<HashSet<_>>().into_iter().collect();

    let sql = format!(
        "SELECT count(*) FROM mindmap_nodes WHERE mindmap_id = ? AND id IN ({})",
        crate::db::sql::in_placeholders(unique_ids.len())
    );
    let mut query = sqlx::query_scalar::<_, i64>(&sql).bind(mindmap_id.db());
    for id in &unique_ids {
        query = query.bind(id.db());
    }
    let count: i64 = query.fetch_one(&mut **tx).await?;

    if count != unique_ids.len() as i64 {
        return Err(Error::Invalid(
            "aresta referencia um nó que não existe ou pertence a outro mapa mental".into(),
        ));
    }
    Ok(())
}
