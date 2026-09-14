//! Repositories for `note_types` and `notes` (`0010_decks_note_types.sql` /
//! `0011_notes_cards.sql`) — the second half of Fase 4's flashcard
//! foundation, alongside `db::decks`.
//!
//! ## Onde nota e cartão se ligam
//!
//! `notes.field_values` é um objeto JSON chaveado pelos nomes em
//! `note_types.fields` (um array JSON de strings, ordem de exibição), e cada
//! entrada de `note_types.templates` (um array JSON, `[{name, front, back}]`)
//! produz exatamente um cartão — `cards.template_ordinal` é o índice dessa
//! entrada. [`NoteRepository::create`] é o único lugar que faz as duas
//! gravações (a nota e seus cartões) na MESMA transação: uma nota sem
//! nenhum cartão não teria como ser estudada, então essa dupla escrita é
//! tudo-ou-nada, não dois passos que um caller poderia observar pela metade.
//!
//! [`NoteRepository::update`] deliberadamente NUNCA toca `cards` — reescrever
//! os cartões de uma nota editada apagaria o agendamento (intervalo, ease,
//! estado FSRS) que `review_log` registrou até aqui. Isso significa que, se
//! um tipo de nota ganhar um template novo depois que notas já existem, as
//! notas antigas não ganham o cartão correspondente automaticamente — não
//! existe hoje nenhum comando IPC de edição de `note_types` (o contrato desta
//! peça não pede um), então esse recálculo fica deliberadamente fora de
//! escopo em vez de implementado pela metade contra uma superfície que ainda
//! não existe.
//!
//! ## Cloze — a exceção a "um cartão por template"
//!
//! [`CLOZE_NOTE_TYPE_NAME`] quebra a premissa acima: o NÚMERO DE CARTÕES de
//! uma nota cloze depende do CONTEÚDO do campo (quantas lacunas
//! `{{cN::texto}}` o texto tem — sintaxe e semântica em `db::cloze`), não da
//! contagem de `note_types.templates`. `note_types.kind` (`cloze` |
//! `standard`, `0040_note_types_kind.sql`) é o discriminador que decide qual
//! das duas regras vale para uma nota — ver o comentário de
//! [`CLOZE_NOTE_TYPE_NAME`] para por que é uma COLUNA, não uma comparação de
//! `name`.
//!
//! [`NoteRepository::create_with_source`] gera um cartão por número de
//! lacuna encontrado. [`NoteRepository::update`] — que continua sem tocar em
//! `cards` para todo tipo PADRÃO — abre uma exceção MÍNIMA só para cloze:
//! reconcilia o conjunto de cartões com o conjunto de lacunas que o texto
//! editado tem AGORA (lacuna nova → cartão novo; lacuna que sumiu → cartão
//! ORFANIZADO, suspenso, nunca apagado; lacuna que continua → cartão
//! intocado). Ver [`sync_cloze_cards`] para a decisão completa e o porquê.
//!
//! ## Origem de um cartão (INT-003 / INT-009)
//!
//! `notes.source_block_id` (um ponteiro vivo, `ON DELETE SET NULL`) e
//! `notes.source_text_frozen` (uma cópia congelada que sobrevive ao ponteiro
//! zerar) já existiam na migração desde a Fase 4, mas nenhum caminho de
//! escrita os preenchia — a integração "leia um bloco, vire um cartão" que
//! esta peça liga. [`NoteRepository::create`] continua sendo o caminho sem
//! origem (nota criada direto no navegador); [`NoteRepository::create_with_source`]
//! é o mesmo, com os dois campos opcionais — ver o comentário daquele método
//! e de [`NoteRepository::resolve_source_text`] para a regra que os liga.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value as JsonValue;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::db::cloze::parse_cloze_numbers;
use crate::db::ids::{DbId, DbIdOpt, IdBind};
use crate::error::{Error, Result};

/// O tipo de nota "Frente e Verso" clássico, semeado desde a Fase 4 — ver o
/// comentário de [`NoteTypeRepository::ensure_default`].
pub(crate) const BASICO_NOTE_TYPE_NAME: &str = "Básico";

/// "Digitar a resposta" (Anki: "Basic (type in the answer)"): a frente pede
/// que o usuário DIGITE a resposta antes de revelar, e a comparação é
/// letra-a-letra (função pura em TypeScript, do lado do estudo — este arquivo
/// só decide os NOMES dos campos e semeia o tipo).
///
/// Campos idênticos ao Básico (`Frente`/`Verso`) de propósito: reaproveitar o
/// vocabulário existente evita introduzir uma terceira convenção de nome de
/// campo para o usuário aprender, e mantém as notas dos dois tipos
/// navegáveis lado a lado no futuro navegador de notas. A tela de estudo já
/// distingue um tipo de nota do outro pelo `noteTypeId`/nome (é exatamente o
/// que `EstudoSessao.tsx` já faz para achar `tipo` na store) — não é preciso
/// nenhum campo a mais para sinalizar "este tipo pede digitação".
///
/// `templates` grava a convenção `{{type:Verso}}` do próprio Anki (front:
/// `{{Frente}}` + `{{type:Verso}}`; back: os mesmos mais `{{Verso}}` cru) só
/// para paridade de import/export de `.apkg` — a mesma razão pela qual
/// `templates` existe no schema (ver o comentário de módulo). A tela de
/// estudo de HOJE não interpreta `{{...}}` nenhum (nem para Básico: ela lê
/// `fields`/`fieldNames` por posição — primeiro campo é a frente, o resto é o
/// verso, ver `db::cards::montar_card_to_study`), então este texto fica
/// inerte até um leitor de `.apkg` existir; não é o gatilho de comportamento.
const DIGITAR_RESPOSTA_NOTE_TYPE_NAME: &str = "Digitar a resposta";

/// "Múltipla escolha": sem equivalente nativo no Anki, então a forma dos
/// campos é uma decisão desta peça, não um espelho de convenção externa.
///
/// Campos: `Pergunta`, `Correta`, `Errada 1`, `Errada 2`, `Errada 3` — NÚMERO
/// FIXO de alternativas (1 certa + 3 erradas), não uma lista de tamanho
/// variável guardada num campo só. Decisão e motivo:
///
/// - variável exigiria codificar várias alternativas dentro de UM valor de
///   `field_values` (um separador feito à mão, tipo `"a; b; c"`) — exatamente
///   a "corrupção silenciosa" que [`build_field_values_json`] já recusa para
///   nome de campo desconhecido: o dia em que uma alternativa contém o
///   próprio separador, ela se parte ao meio em silêncio;
/// - campo fixo e nomeado passa pela MESMA validação que Básico já usa
///   (contagem de campos, `algum_preenchido`), sem nenhum parser novo;
/// - custo aceito: quem quiser uma quinta alternativa não tem onde pôr. Se
///   isso incomodar no uso real, é uma migração de campo (não deste arquivo)
///   para adicionar `Errada 4` — não uma mudança de formato.
///
/// "E se só `Correta` estiver preenchida?" — a nota ainda é válida (`Correta`
/// sozinha já satisfaz "algum campo preenchido"); as três erradas em branco
/// não são rejeitadas aqui. Cabe à tela de estudo (não a este arquivo)
/// decidir como desenhar uma múltipla escolha degenerada de uma alternativa
/// só — comentário deixado para quem escrever aquele lado, porque não há
/// dado nenhum aqui que decida por ela.
const MULTIPLA_ESCOLHA_NOTE_TYPE_NAME: &str = "Múltipla escolha";

/// "Cloze" (lacuna): o tipo mais usado do Anki, e o único cujo NÚMERO DE
/// CARTÕES depende do CONTEÚDO do campo, não da contagem de `templates` —
/// ver "Cloze — a exceção..." no comentário de módulo (topo do arquivo) e
/// `db::cloze` para a sintaxe/semântica (`{{c1::texto}}`,
/// `{{c1::texto::dica}}`) e o porquê de cada regra do parser.
///
/// Dois campos: `Texto` (a marcação `{{cN::...}}` mora aqui) e `Extra`
/// (mostrado só depois de revelar a lacuna — convenção do próprio Anki,
/// "Back Extra"). `Texto` é sempre o PRIMEIRO campo declarado — a mesma
/// convenção "campo 0 é o especial" que `EstudoSessao.tsx` já usa para achar
/// a frente de um cartão Básico — então [`cloze_card_numbers`] lê
/// `field_names[0]`, nunca o literal `"Texto"`: continuaria funcionando se
/// `Extra` ganhasse outro nome no futuro, contanto que `Texto` continue
/// primeiro.
///
/// `templates` grava um único template (`front: "{{cloze:Texto}}"`, a mesma
/// convenção `{{cloze:Campo}}` do próprio Anki, pela mesma razão de
/// [`DIGITAR_RESPOSTA_NOTE_TYPE_NAME`] registrar `{{type:Verso}}`: paridade
/// de import/export de `.apkg`, texto inerte até um leitor de `.apkg`
/// existir) — mas esse array NUNCA decide quantos cartões uma nota cloze
/// tem. Só `note_types.kind == "cloze"` decide isso, desviando inteiramente
/// de [`template_count`] (ver [`NoteRepository::create_with_source`] e
/// [`NoteRepository::update`]).
///
/// `kind` — POR QUE UMA COLUNA NOVA, NÃO SÓ COMPARAR `name` (decisão que
/// `0040_note_types_kind.sql` grava): os três tipos embutidos anteriores já
/// são distinguidos por NOME, mas só para SEMEAR (`ensure_default`) — nenhum
/// deles muda COMO `create`/`update` escrevem `cards`. Cloze muda: o caminho
/// de geração de cartão inteiro bifurca. Comparar `note_type.name ==
/// "Cloze"` para essa bifurcação amarraria comportamento de escrita ao
/// RÓTULO DE EXIBIÇÃO — o dia em que existir uma tela de renomear tipo de
/// nota (não existe hoje, mesmo motivo citado no comentário de módulo sobre
/// não haver comando de edição de `note_types`), renomear "Cloze" quebraria
/// a geração de cartão em silêncio. `kind` é a mesma escolha que o próprio
/// Anki faz internamente (`notetypes.config.kind`: Normal | Cloze) — um
/// discriminador que sobrevive a qualquer nome de exibição.
pub(crate) const CLOZE_NOTE_TYPE_NAME: &str = "Cloze";

/// Valores de `note_types.kind` (`0040_note_types_kind.sql`) — ver o
/// comentário de [`CLOZE_NOTE_TYPE_NAME`] para a decisão completa.
pub(crate) const NOTE_TYPE_KIND_STANDARD: &str = "standard";
/// `pub(crate)`: `db::cards::CardRepository::montar_card_to_study` compara o
/// `kind` da nota com este valor para decidir se renderiza a lacuna — a
/// mesma constante, para os dois lados nunca discordarem sobre a grafia.
pub(crate) const NOTE_TYPE_KIND_CLOZE: &str = "cloze";

const NOTE_TYPE_COLUMNS: &str = "id, name, kind, fields, templates, created_at, updated_at";
const NOTE_COLUMNS: &str =
    "id, note_type_id, deck_id, field_values, tags, source_block_id, source_text_frozen, deleted_at, created_at, updated_at";

/// Mirrors `note_types` field-for-field. `fields`/`templates` stay raw JSON
/// here (the same choice `DeckRow.options`/`BlockRow.content` make) rather
/// than a typed `Vec<String>`/`Vec<Template>`: the only two things this crate
/// needs from them — how many fields a note must supply, and how many
/// templates a note must produce a card for — are cheap to pull out of the
/// JSON on demand (see [`parse_field_names`]/[`template_count`]) without a
/// bespoke `sqlx` decode for a shape only this file reads.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTypeRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    pub name: String,
    /// `"standard"` | `"cloze"` — ver o comentário de
    /// [`CLOZE_NOTE_TYPE_NAME`] para o porquê deste campo existir e não ser
    /// só uma comparação de `name`.
    pub kind: String,
    pub fields: JsonValue,
    pub templates: JsonValue,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Os valores de campo de uma nota, chaveados pelo NOME do campo.
///
/// Por nome, e não por posição, e a diferença importa: `note_types.fields` é
/// uma lista ordenada, e reordenar ou renomear um campo lá — coisa que o
/// usuário faz — deslocaria em silêncio todo valor já gravado se o contrato
/// fosse posicional. A coluna `notes.field_values` já é um objeto JSON por
/// nome; este tipo é o mesmo formato subindo até a fronteira de IPC, onde o
/// frontend também fala por nome.
pub type FieldValues = std::collections::HashMap<String, String>;

/// Mirrors `notes` field-for-field. `field_values` chega e volta como o mesmo
/// objeto JSON (`{"Frente": "...", "Verso": "..."}`) que a coluna guarda — ver
/// [`FieldValues`] para por que por nome e nunca por posicao.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRow {
    #[sqlx(try_from = "DbId")]
    pub id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub note_type_id: Uuid,
    #[sqlx(try_from = "DbId")]
    pub deck_id: Uuid,
    pub field_values: JsonValue,
    pub tags: JsonValue,
    #[sqlx(try_from = "DbIdOpt")]
    pub source_block_id: Option<Uuid>,
    pub source_text_frozen: Option<String>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct NoteTypeRepository {
    pool: SqlitePool,
}

impl NoteTypeRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Every note type, oldest first. Seeds the four built-in note types —
    /// "Básico", "Digitar a resposta", "Múltipla escolha", "Cloze" — the
    /// first time each is missing: a fresh install has no `note_types` row at all
    /// (nothing in `migrations/` seeds one, by this piece's own instruction:
    /// the schema is owned by another workflow), and without at least one,
    /// `create_note` could never produce a card.
    ///
    /// Seeding here (on first read) rather than in a migration keeps the
    /// schema files untouched, and [`ensure_note_type_seeded`]'s `INSERT ...
    /// WHERE NOT EXISTS` is the single statement that makes "exactly once
    /// per name" true without a check-then-insert race: SQLite evaluates and
    /// applies it atomically, so two overlapping calls (the same
    /// `React.StrictMode` double-effect `AppState::lock_workspace_open`
    /// already guards against elsewhere) can never both see zero matching
    /// rows and both insert — the second one's `WHERE NOT EXISTS` sees the
    /// first one's row, committed or not, because SQLite serializes writers.
    ///
    /// PER NAME, not "whole table empty": every database that existed before
    /// this piece added the two new types already has exactly one row
    /// (`Básico`), so a table-wide `WHERE NOT EXISTS (SELECT 1 FROM
    /// note_types)` would see that row forever and never seed the other two.
    /// Checking existence by name lets a database at ANY of the three
    /// possible starting points — brand new, "Básico" only, or already
    /// fully seeded — converge on the same three rows, each inserted at most
    /// once.
    pub async fn list(&self) -> Result<Vec<NoteTypeRow>> {
        self.ensure_default().await?;

        let rows = sqlx::query_as::<_, NoteTypeRow>(&format!(
            "SELECT {NOTE_TYPE_COLUMNS} FROM note_types ORDER BY created_at"
        ))
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    /// Semeia os quatro tipos de nota embutidos — ver o comentário de
    /// [`list`](Self::list) para por que cada um é checado por NOME, não pelo
    /// total da tabela, e os comentários de [`DIGITAR_RESPOSTA_NOTE_TYPE_NAME`]
    /// / [`MULTIPLA_ESCOLHA_NOTE_TYPE_NAME`] / [`CLOZE_NOTE_TYPE_NAME`] para a
    /// forma dos campos.
    async fn ensure_default(&self) -> Result<()> {
        self.ensure_note_type_seeded(
            BASICO_NOTE_TYPE_NAME,
            NOTE_TYPE_KIND_STANDARD,
            serde_json::json!(["Frente", "Verso"]),
            serde_json::json!([{ "name": "Cartão 1", "front": "{{Frente}}", "back": "{{Verso}}" }]),
        )
        .await?;

        self.ensure_note_type_seeded(
            DIGITAR_RESPOSTA_NOTE_TYPE_NAME,
            NOTE_TYPE_KIND_STANDARD,
            serde_json::json!(["Frente", "Verso"]),
            serde_json::json!([{
                "name": "Cartão 1",
                "front": "{{Frente}}\n\n{{type:Verso}}",
                "back": "{{Frente}}\n\n{{type:Verso}}\n\n{{Verso}}",
            }]),
        )
        .await?;

        self.ensure_note_type_seeded(
            MULTIPLA_ESCOLHA_NOTE_TYPE_NAME,
            NOTE_TYPE_KIND_STANDARD,
            serde_json::json!(["Pergunta", "Correta", "Errada 1", "Errada 2", "Errada 3"]),
            serde_json::json!([{ "name": "Cartão 1", "front": "{{Pergunta}}", "back": "{{Correta}}" }]),
        )
        .await?;

        self.ensure_note_type_seeded(
            CLOZE_NOTE_TYPE_NAME,
            NOTE_TYPE_KIND_CLOZE,
            serde_json::json!(["Texto", "Extra"]),
            serde_json::json!([{ "name": "Cloze", "front": "{{cloze:Texto}}", "back": "{{cloze:Texto}}\n\n{{Extra}}" }]),
        )
        .await?;

        Ok(())
    }

    /// Insere um tipo de nota embutido com nome `nome` só se uma linha com
    /// esse nome ainda não existir — ver o comentário de
    /// [`list`](Self::list) para por que "por nome" (e não "tabela vazia") é
    /// o que torna a migração de um banco só-com-Básico segura.
    ///
    /// `$2` aparece duas vezes na consulta (o valor inserido e o filtro do
    /// `WHERE NOT EXISTS`) e é ligado uma vez só — mesma convenção já usada
    /// em `db::blocks`/`db::cards`/`db::trilha` para um parâmetro reaparecer
    /// numa query SQLite.
    async fn ensure_note_type_seeded(
        &self,
        nome: &str,
        kind: &str,
        fields: JsonValue,
        templates: JsonValue,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO note_types (id, name, kind, fields, templates) \
             SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM note_types WHERE name = $2)",
        )
        .bind(Uuid::now_v7().db())
        .bind(nome)
        .bind(kind)
        .bind(&fields)
        .bind(&templates)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn get(&self, id: Uuid) -> Result<NoteTypeRow> {
        sqlx::query_as::<_, NoteTypeRow>(&format!("SELECT {NOTE_TYPE_COLUMNS} FROM note_types WHERE id = $1"))
            .bind(id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("tipo de nota {id}")))
    }
}

pub struct NoteRepository {
    pool: SqlitePool,
}

impl NoteRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Creates a note with no origin — a note typed directly in the browser,
    /// with `source_block_id`/`source_text_frozen` both `NULL`. This is, and
    /// must stay, the normal path: it is a thin wrapper over
    /// [`create_with_source`](Self::create_with_source) so that every
    /// existing caller (this crate has several, none of which know about
    /// "origem") keeps compiling and behaving byte-for-byte the same after
    /// this piece — see that method's doc for the two-column pair this
    /// signature intentionally still hides.
    pub async fn create(
        &self,
        deck_id: Uuid,
        note_type_id: Uuid,
        field_values: FieldValues,
        tags: Vec<String>,
    ) -> Result<NoteRow> {
        self.create_with_source(deck_id, note_type_id, field_values, tags, None, None).await
    }

    /// Creates a note and, in the same transaction, one card per template of
    /// its note type — see this module's doc comment for why the two writes
    /// are inseparable. Rejects up front (before any write):
    ///
    /// - a `deck_id`/`note_type_id` that does not exist (`Error::NotFound`,
    ///   instead of letting the FK produce an opaque `Error::Database`);
    /// - a deck that is in the trash (`Error::Invalid` — creating a card
    ///   nobody's active deck tree can reach would be corruption a user
    ///   could not see);
    /// - a `source_block_id` that does not name an active block
    ///   (`Error::NotFound` — see [`resolve_source_text`](Self::resolve_source_text));
    /// - `field_values.len()` not matching the note type's `fields.len()`
    ///   (`Error::Invalid`, naming both numbers — the exact silent-corruption
    ///   case this piece's brief calls out);
    /// - a note type with zero templates (`Error::Invalid` — it could never
    ///   produce a studyable card, so refusing here is louder than creating a
    ///   permanently cardless note).
    ///
    /// ## `source_block_id` / `source_text_frozen` — INT-003 / INT-009
    ///
    /// Both are optional and independent, on purpose:
    ///
    /// - **only `source_block_id`** is the normal "made this card from a
    ///   block I'm looking at" flow. `source_text_frozen` is filled in here,
    ///   from that block's current `plain_text` — see
    ///   [`resolve_source_text`](Self::resolve_source_text) for why this is a
    ///   fill-in rather than a rejection.
    /// - **only `source_text_frozen`** is the mind-map-node origin this
    ///   piece's brief calls out as a case to surface, not solve: a mind-map
    ///   node lives in `mindmap_nodes`, and `source_block_id` can only ever
    ///   reference `blocks(id)` (`0011_notes_cards.sql`). There is no schema
    ///   column today a mind-map node's id could go in, so this is the
    ///   entire "origin" a card born from one can carry — frozen text, no
    ///   clickable link back. Making that link real needs a schema change
    ///   (e.g. a nullable `source_mindmap_node_id` column, or widening
    ///   `source_block_id`'s meaning to "either kind of node" with a
    ///   discriminant column) that is deliberately **not** made by this
    ///   piece — see this crate's brief for why that decision belongs
    ///   elsewhere.
    /// - **both** lets a caller override the frozen text instead of taking
    ///   the whole block verbatim — e.g. freezing only the sentence the user
    ///   actually selected, not the block's entire `plain_text`.
    /// - **neither** is [`create`](Self::create)'s case: an ordinary note.
    pub async fn create_with_source(
        &self,
        deck_id: Uuid,
        note_type_id: Uuid,
        field_values: FieldValues,
        tags: Vec<String>,
        source_block_id: Option<Uuid>,
        source_text_frozen: Option<String>,
    ) -> Result<NoteRow> {
        let note_type = NoteTypeRepository::new(self.pool.clone()).get(note_type_id).await?;
        self.ensure_deck_is_active(deck_id).await?;
        // Um cartão nasce com o `scheduler` que o BARALHO tem configurado
        // AGORA — não muda depois se o baralho trocar de preset (a decisão
        // documentada em `db::cards::CardRepository::answer_card`, braço
        // "fsrs": `cards.scheduler` é gravado uma vez, na criação, e nunca
        // reescrito).
        let scheduler = self.deck_scheduler(deck_id).await?;
        let source_text_frozen = self.resolve_source_text(source_block_id, source_text_frozen).await?;

        let field_names = parse_field_names(&note_type.fields)?;
        let field_values_json = build_field_values_json(&field_names, &field_values)?;
        let tags_json = JsonValue::Array(tags.into_iter().map(JsonValue::String).collect());

        // Cloze desvia inteiramente de `template_count` — ver "Cloze — a
        // exceção..." no comentário de módulo e o comentário de
        // `CLOZE_NOTE_TYPE_NAME`. Todo `ordinal` já sai convertido para `i64`
        // daqui, então `insert_card` não precisa mais fazer conversão
        // nenhuma.
        let ordinais: Vec<i64> = if note_type.kind == NOTE_TYPE_KIND_CLOZE {
            let numeros = cloze_card_numbers(&field_names, &field_values_json)?;
            if numeros.is_empty() {
                return Err(Error::Invalid(
                    "nota cloze precisa de pelo menos uma lacuna {{c1::...}} no primeiro campo; \
                     nenhuma foi encontrada"
                        .into(),
                ));
            }
            numeros.into_iter().map(i64::from).collect()
        } else {
            let template_total = template_count(&note_type.templates)?;
            if template_total == 0 {
                return Err(Error::Invalid(format!(
                    "tipo de nota \"{}\" não tem nenhum modelo de cartão; não é possível criar cartões",
                    note_type.name
                )));
            }
            (0..template_total)
                .map(|ordinal| {
                    i64::try_from(ordinal).map_err(|_| {
                        Error::Invalid("tipo de nota tem modelos demais para caber num contador de 64 bits".into())
                    })
                })
                .collect::<Result<Vec<i64>>>()?
        };

        let mut tx = self.pool.begin().await?;

        let note_id = Uuid::now_v7();
        let note = sqlx::query_as::<_, NoteRow>(&format!(
            "INSERT INTO notes (id, note_type_id, deck_id, field_values, tags, source_block_id, source_text_frozen) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             RETURNING {NOTE_COLUMNS}"
        ))
        .bind(note_id.db())
        .bind(note_type_id.db())
        .bind(deck_id.db())
        .bind(&field_values_json)
        .bind(&tags_json)
        .bind(source_block_id.db())
        .bind(&source_text_frozen)
        .fetch_one(&mut *tx)
        .await?;

        for ordinal in ordinais {
            insert_card(&mut tx, note_id, ordinal, deck_id, &scheduler).await?;
        }

        tx.commit().await?;
        Ok(note)
    }

    /// The rule that gives the `source_block_id`/`source_text_frozen` pair
    /// its reason to exist (this piece's brief, item 2): `source_text_frozen`
    /// is never redundant with the block, because the block can be deleted
    /// later and the FK (`ON DELETE SET NULL`, `0011_notes_cards.sql`) zeroes
    /// `source_block_id` when that happens — a note recording a
    /// `source_block_id` with no frozen text would go silently provenance-less
    /// the day its block disappears, which is precisely the "corrupção
    /// silenciosa" this whole codebase's brief keeps naming as the thing to
    /// refuse rather than let happen.
    ///
    /// Chosen resolution, blank treated the same as absent in every branch
    /// below (a whitespace-only string carries the same "nothing meaningful
    /// was given" information as `None` — Anki's own blank-field rule
    /// [`build_field_values_json`] already applies elsewhere in this file):
    ///
    /// - no block, no text → `Ok(None)`: an ordinary note, no origin at all.
    /// - no block, blank text → **rejected**: a blank string with nothing to
    ///   fall back on carries zero provenance value, and accepting it would
    ///   let a caller bug (an empty selection, say) through silently.
    /// - no block, real text → kept as given: the mind-map-node case (see
    ///   [`create_with_source`](Self::create_with_source)'s doc) — there is
    ///   no block to fall back on, and none is needed.
    /// - a block, blank or absent text → **filled in from the block's own
    ///   `plain_text`**, not rejected. Unlike the no-block case there IS a
    ///   safe fallback, and refusing would just push the exact same
    ///   `block.plain_text` string back onto every caller — a copy this
    ///   repository is in a strictly better position to make correctly than
    ///   however many call sites would otherwise repeat it.
    /// - a block, real text → kept as given: an explicit override (e.g. only
    ///   the sentence the user selected, not the block's entire text).
    ///
    /// The block named by `source_block_id`, when given, must be an active
    /// one (`deleted_at IS NULL`) — mirrors [`ensure_deck_is_active`]'s same
    /// check for `deck_id`, for the same reason: this method is the "I am
    /// looking at this block right now" flow, so a block already in the
    /// trash at creation time is a caller bug to surface (`Error::NotFound`),
    /// not a state to quietly accept.
    async fn resolve_source_text(
        &self,
        source_block_id: Option<Uuid>,
        source_text_frozen: Option<String>,
    ) -> Result<Option<String>> {
        let Some(block_id) = source_block_id else {
            // Sem bloco, um texto SÓ DE ESPAÇOS é diferente de nenhum texto:
            // `None` é "sem origem nenhuma" (nota comum), válido; `Some("  ")`
            // é um chamador tentando declarar origem sem dar nada de fato
            // aproveitável, e sem bloco não há de onde puxar um substituto —
            // por isso a checagem de branco olha o valor ORIGINAL, antes de
            // qualquer filtro, e só se aplica neste ramo.
            let is_blank = source_text_frozen.as_deref().is_some_and(|text| text.trim().is_empty());
            if is_blank {
                return Err(Error::Invalid(
                    "texto congelado em branco sem um bloco de origem não tem função; informe um texto ou remova o campo"
                        .into(),
                ));
            }
            return Ok(source_text_frozen);
        };

        // Com bloco, texto em branco OU ausente caem no mesmo lugar: há um
        // substituto seguro (o `plain_text` do próprio bloco), então não há
        // motivo para recusar — ver o comentário deste método acima.
        match source_text_frozen.filter(|text| !text.trim().is_empty()) {
            Some(text) => Ok(Some(text)),
            None => Ok(Some(self.fetch_active_block_plain_text(block_id).await?)),
        }
    }

    /// `source_block_id`'s fallback source of truth — see
    /// [`resolve_source_text`](Self::resolve_source_text). Reads straight
    /// from `blocks` rather than going through `db::blocks::BlockRepository`:
    /// the only thing needed here is one column of one active row, and
    /// pulling in that repository would be a whole module dependency for a
    /// single scalar read this file already knows how to do (every other
    /// method here reads a foreign table — `decks`, `note_types` — the same
    /// direct way).
    async fn fetch_active_block_plain_text(&self, block_id: Uuid) -> Result<String> {
        sqlx::query_scalar("SELECT plain_text FROM blocks WHERE id = $1 AND deleted_at IS NULL")
            .bind(block_id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("bloco ativo {block_id}")))
    }

    /// Updates a note's field values and tags. Never touches `cards` FOR UM
    /// TIPO PADRÃO — ver este módulo's doc comment. Rejects a note that is
    /// in the trash (an update would otherwise silently resurrect its
    /// content without resurrecting `deleted_at`) and a field-count
    /// mismatch, exactly like [`create`](Self::create).
    ///
    /// Para um tipo CLOZE, a exceção mínima descrita em "Cloze — a exceção..."
    /// (comentário de módulo): depois de gravar o novo `field_values`, chama
    /// [`sync_cloze_cards`] para reconciliar os cartões com as lacunas que o
    /// texto editado tem agora. `deck_scheduler` é lido ANTES de abrir a
    /// transação, mesmo padrão de
    /// [`create_with_source`](Self::create_with_source): um erro de
    /// validação (nenhuma lacuna no texto editado) precisa acontecer antes de
    /// qualquer escrita, nunca no meio de uma transação já aberta.
    pub async fn update(&self, note_id: Uuid, field_values: FieldValues, tags: Vec<String>) -> Result<NoteRow> {
        let existing = self.get_active(note_id).await?;
        let note_type = NoteTypeRepository::new(self.pool.clone()).get(existing.note_type_id).await?;

        let field_names = parse_field_names(&note_type.fields)?;
        let field_values_json = build_field_values_json(&field_names, &field_values)?;
        let tags_json = JsonValue::Array(tags.into_iter().map(JsonValue::String).collect());

        let cloze_sync = if note_type.kind == NOTE_TYPE_KIND_CLOZE {
            let numeros = cloze_card_numbers(&field_names, &field_values_json)?;
            if numeros.is_empty() {
                return Err(Error::Invalid(
                    "nota cloze precisa de pelo menos uma lacuna {{c1::...}} no primeiro campo; \
                     nenhuma foi encontrada"
                        .into(),
                ));
            }
            let scheduler = self.deck_scheduler(existing.deck_id).await?;
            Some((numeros, scheduler))
        } else {
            None
        };

        let mut tx = self.pool.begin().await?;

        let row = sqlx::query_as::<_, NoteRow>(&format!(
            "UPDATE notes SET field_values = $2, tags = $3 WHERE id = $1 AND deleted_at IS NULL RETURNING {NOTE_COLUMNS}"
        ))
        .bind(note_id.db())
        .bind(&field_values_json)
        .bind(&tags_json)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Error::NotFound(format!("nota {note_id}")))?;

        if let Some((numeros, scheduler)) = cloze_sync {
            sync_cloze_cards(&mut tx, note_id, existing.deck_id, &scheduler, &numeros).await?;
        }

        tx.commit().await?;
        Ok(row)
    }

    /// Soft-deletes the note and, in the same transaction, suspends every
    /// card it still has in play (`state <> 'suspended'` already) instead of
    /// deleting them.
    ///
    /// Cards have no `deleted_at` of their own (`0011_notes_cards.sql`), and
    /// a hard `DELETE FROM cards` would cascade into `review_log`
    /// (`ON DELETE CASCADE`) — the one table this codebase documents as
    /// "never overwritten once written" (see `0012_review_log.sql`'s own
    /// comment, and SRS-093's FSRS parameter optimizer, which reads it).
    /// Suspending keeps every review intact and reversible in spirit — a
    /// future `restore_note` (out of this contract) would only need to flip
    /// `deleted_at` and the suspended cards back, never reconstruct lost
    /// history.
    pub async fn delete(&self, note_id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        let result = sqlx::query("UPDATE notes SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $1 AND deleted_at IS NULL")
            .bind(note_id.db())
            .execute(&mut *tx)
            .await?;

        if result.rows_affected() == 0 {
            drop(tx);
            self.get(note_id).await?;
            return Err(Error::Invalid("nota já está na lixeira".into()));
        }

        sqlx::query(
            "UPDATE cards SET state = 'suspended', suspended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             WHERE note_id = $1 AND state <> 'suspended'",
        )
        .bind(note_id.db())
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    /// Active notes, optionally restricted to one deck, newest first — backs
    /// the notes browser. `limit`/`offset` come straight from an IPC caller
    /// (hostile input, rule 11 of the project brief): negative values are
    /// rejected instead of being handed to SQLite, whose `LIMIT -1` means
    /// "no limit" and `OFFSET` with a negative value is simply an error a
    /// caller would have to decode from a raw `Error::Database`.
    pub async fn list(&self, deck_id: Option<Uuid>, limit: i64, offset: i64) -> Result<Vec<NoteRow>> {
        if limit < 0 || offset < 0 {
            return Err(Error::Invalid("limit e offset precisam ser não negativos".into()));
        }

        let rows = sqlx::query_as::<_, NoteRow>(&format!(
            "SELECT {NOTE_COLUMNS} FROM notes \
             WHERE deleted_at IS NULL AND deck_id = COALESCE($1, deck_id) \
             ORDER BY created_at DESC LIMIT $2 OFFSET $3"
        ))
        .bind(deck_id.db())
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    async fn get(&self, id: Uuid) -> Result<NoteRow> {
        sqlx::query_as::<_, NoteRow>(&format!("SELECT {NOTE_COLUMNS} FROM notes WHERE id = $1"))
            .bind(id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("nota {id}")))
    }

    async fn get_active(&self, id: Uuid) -> Result<NoteRow> {
        let note = self.get(id).await?;
        if note.deleted_at.is_some() {
            return Err(Error::Invalid("nota está na lixeira".into()));
        }
        Ok(note)
    }

    async fn ensure_deck_is_active(&self, deck_id: Uuid) -> Result<()> {
        let deleted_at: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT deleted_at FROM decks WHERE id = $1")
            .bind(deck_id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("baralho {deck_id}")))?;

        if deleted_at.is_some() {
            return Err(Error::Invalid("baralho está na lixeira".into()));
        }
        Ok(())
    }

    /// `"sm2"` | `"fsrs"` — o agendador que `decks.options` tem configurado
    /// AGORA para este baralho (`crate::srs::Agendador`, via o mesmo
    /// `crate::db::cards::parse_opcoes_de_deck` que `answer_card` usa, para
    /// que as duas peças nunca leiam a mesma chave JSON de dois jeitos
    /// diferentes). Ronda de banco separada de [`Self::ensure_deck_is_active`]
    /// de propósito — a existência do baralho já foi confirmada ali, e
    /// juntar os dois numa consulta só economizaria um round-trip que não é
    /// caminho quente (criar uma nota não é um loop apertado).
    async fn deck_scheduler(&self, deck_id: Uuid) -> Result<String> {
        let raw: JsonValue = sqlx::query_scalar("SELECT options FROM decks WHERE id = $1")
            .bind(deck_id.db())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| Error::NotFound(format!("baralho {deck_id}")))?;
        Ok(crate::db::cards::parse_opcoes_de_deck(&raw).agendador.as_str().to_string())
    }
}

/// `note_types.fields` mirror: an ordered array of field-name strings. A
/// non-array or non-string entry means the row is corrupt (should be
/// impossible given the `CHECK (json_valid(fields))` plus this being the
/// only writer of that shape, but this crosses a DB boundary — rule 3 bars a
/// silent `unwrap` here just as much as anywhere else).
fn parse_field_names(fields_json: &JsonValue) -> Result<Vec<String>> {
    fields_json
        .as_array()
        .ok_or_else(|| Error::Invalid("tipo de nota corrompido: \"fields\" não é um array JSON".into()))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| Error::Invalid("tipo de nota corrompido: nome de campo não é uma string".into()))
        })
        .collect()
}

/// `note_types.templates` mirror — this file only ever needs the count (one
/// card per template), never the template body (rendering `{{Field}}`
/// placeholders is a study-screen concern, out of this piece's scope).
fn template_count(templates_json: &JsonValue) -> Result<usize> {
    templates_json
        .as_array()
        .map(Vec::len)
        .ok_or_else(|| Error::Invalid("tipo de nota corrompido: \"templates\" não é um array JSON".into()))
}

/// Zips the note type's field names with the caller's positional values into
/// the JSON object `notes.field_values` stores — and this is the barrier the
/// piece's brief calls for: a length mismatch is exactly the "corrupção
/// silenciosa" a raw zip-and-truncate would produce, so it is rejected here,
/// by name, before any row is touched.
fn build_field_values_json(field_names: &[String], field_values: &FieldValues) -> Result<JsonValue> {
    // Chave desconhecida é erro, não algo a ignorar: um campo digitado errado
    // ("Fente" em vez de "Frente") sumiria em silêncio e a nota nasceria com o
    // conteúdo perdido. É o mesmo motivo pelo qual a versão posicional deste
    // código conferia o tamanho.
    for nome in field_values.keys() {
        if !field_names.iter().any(|conhecido| conhecido == nome) {
            return Err(Error::Invalid(format!(
                "campo \"{nome}\" não existe neste tipo de nota; os campos são: {}",
                field_names.join(", ")
            )));
        }
    }

    // Campo ausente vira string vazia, e isso é deliberado: o Anki aceita nota
    // com campo em branco (uma nota "Básico" só com a frente preenchida é um
    // rascunho legítimo), e exigir a chave obrigaria a UI a mandar todo campo
    // vazio explicitamente. O que NÃO é aceitável é a nota inteira vazia — aí
    // não há o que estudar, e o cartão nasceria em branco.
    let mut map = serde_json::Map::with_capacity(field_names.len());
    let mut algum_preenchido = false;
    for nome in field_names {
        let valor = field_values.get(nome).map(String::as_str).unwrap_or_default();
        if !valor.trim().is_empty() {
            algum_preenchido = true;
        }
        map.insert(nome.clone(), JsonValue::String(valor.to_string()));
    }

    if !algum_preenchido {
        return Err(Error::Invalid(
            "uma nota precisa de pelo menos um campo preenchido — senão o cartão nasce em branco".into(),
        ));
    }

    Ok(JsonValue::Object(map))
}

/// One card for `note_id`'s `ordinal`. O SIGNIFICADO de `ordinal` depende do
/// `kind` do tipo de nota da nota — índice em `templates` para um tipo
/// PADRÃO, número de lacuna `cN` para um tipo CLOZE (ver o comentário de
/// campo de `db::cards::CardRow::template_ordinal` para a decisão completa
/// de reusar esta coluna em vez de abrir uma nova). Quem chama já converteu
/// e validou para `i64` ([`NoteRepository::create_with_source`] a partir de
/// `usize`/`u32`, [`sync_cloze_cards`] a partir de `u32`) — este ponto não
/// faz mais nenhuma conversão numérica, só grava.
///
/// Every other column (`state`, `interval_days`, `ease_factor`, ...) keeps
/// the table's own `DEFAULT` — a brand-new card always starts in the same
/// "never studied" state regardless of which template/lacuna produced it.
/// `scheduler` is the ONE exception: it is passed in explicitly, already
/// resolved from the deck's `decks.options` by the caller
/// (`Self::deck_scheduler`), instead of falling through to the column's own
/// `DEFAULT 'sm2'` — a card created under a deck configured for FSRS must be
/// born `'fsrs'`, not silently `'sm2'` until someone remembers to flip it
/// later.
async fn insert_card(tx: &mut Transaction<'_, Sqlite>, note_id: Uuid, ordinal: i64, deck_id: Uuid, scheduler: &str) -> Result<()> {
    sqlx::query("INSERT INTO cards (id, note_id, template_ordinal, deck_id, scheduler) VALUES ($1, $2, $3, $4, $5)")
        .bind(Uuid::now_v7().db())
        .bind(note_id.db())
        .bind(ordinal)
        .bind(deck_id.db())
        .bind(scheduler)
        .execute(&mut **tx)
        .await?;

    Ok(())
}

/// Os números de lacuna do texto de uma nota CLOZE — sempre lidos do
/// PRIMEIRO campo declarado (ver o comentário de [`CLOZE_NOTE_TYPE_NAME`]
/// para o porquê de ser por posição, não pelo literal `"Texto"`).
/// `field_values_json` já passou por [`build_field_values_json`] (toda chave
/// de `field_names` presente, mesmo que vazia), então não há campo ausente a
/// tratar aqui — só o caso degenerado de um tipo de nota cloze sem NENHUM
/// campo declarado, que só um `note_types` corrompido por fora deste crate
/// produziria.
fn cloze_card_numbers(field_names: &[String], field_values_json: &JsonValue) -> Result<Vec<u32>> {
    let Some(primeiro_campo) = field_names.first() else {
        return Err(Error::Invalid("tipo de nota cloze corrompido: nenhum campo declarado".into()));
    };
    let texto = field_values_json.get(primeiro_campo).and_then(JsonValue::as_str).unwrap_or_default();
    Ok(parse_cloze_numbers(texto))
}

/// Reconcilia os cartões de uma nota CLOZE com `desejados` — o conjunto de
/// números de lacuna que o texto editado tem AGORA ([`cloze_card_numbers`]) —
/// as três perguntas da bar desta peça, nesta ordem:
///
/// 1. **lacuna nova** (em `desejados`, sem cartão em `cards` ainda) → cria um
///    cartão ([`insert_card`], o mesmo caminho que a criação da nota usa —
///    nasce com o mesmo estado "nunca estudado" e o `scheduler` do baralho
///    AGORA);
/// 2. **lacuna que sumiu** (tinha cartão, não está mais em `desejados`) →
///    SUSPENDE o cartão (`state <> 'suspended'`, mesmo idioma de
///    [`NoteRepository::delete`]), nunca apaga: apagar cascatearia
///    `review_log` (`ON DELETE CASCADE`) — a mesma razão pela qual `delete`
///    já suspende em vez de apagar. Decisão espelhando o próprio Anki, que
///    avisa em vez de apagar em silêncio ao remover uma lacuna: este
///    contrato é só backend (sem UI para avisar), então suspender é o
///    equivalente mudo — o cartão sai da fila de estudo em vez de continuar
///    perguntando um texto que não existe mais, mas `review_log`,
///    `interval_days`, `ease_factor` e o estado FSRS continuam intactos;
/// 3. **lacuna que já tinha cartão E continua em `desejados`** → INTOCADA.
///    Nem aparece em `novos` nem em `orfaos` abaixo — nenhuma das duas
///    diferenças de conjunto a contém — e é assim que esta função garante,
///    POR CONSTRUÇÃO, que um cartão sobrevivente nunca sofre um `UPDATE`
///    aqui (a prova de que `interval_days`/`ease_factor`/`fsrs_*`/`lapses`/
///    `reps`/`due` saem idênticos é um teste de banco, não uma inspeção de
///    código: `update_note_cloze_cartao_que_sobrevive_mantem_agendamento_identico`).
///
/// Deliberadamente NÃO reativa um cartão suspenso cujo número reaparece numa
/// edição seguinte: a suspensão (como a de [`NoteRepository::delete`])
/// SOBRESCREVE `state` sem guardar o valor anterior (`review`? `learning`?),
/// então não há para que estado voltar sem inventar um valor. Reativação
/// fica para quando existir uma tela de edição de cartão — fora do escopo
/// desta peça.
async fn sync_cloze_cards(
    tx: &mut Transaction<'_, Sqlite>,
    note_id: Uuid,
    deck_id: Uuid,
    scheduler: &str,
    desejados: &[u32],
) -> Result<()> {
    let ordinais_existentes: Vec<i64> = sqlx::query_scalar("SELECT template_ordinal FROM cards WHERE note_id = $1")
        .bind(note_id.db())
        .fetch_all(&mut **tx)
        .await?;
    let existentes: std::collections::HashSet<i64> = ordinais_existentes.into_iter().collect();
    let desejados: std::collections::HashSet<i64> = desejados.iter().map(|&numero| i64::from(numero)).collect();

    for ordinal in desejados.difference(&existentes) {
        insert_card(tx, note_id, *ordinal, deck_id, scheduler).await?;
    }

    for ordinal in existentes.difference(&desejados) {
        sqlx::query(
            "UPDATE cards SET state = 'suspended', suspended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             WHERE note_id = $1 AND template_ordinal = $2 AND state <> 'suspended'",
        )
        .bind(note_id.db())
        .bind(*ordinal)
        .execute(&mut **tx)
        .await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {

    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    /// Acucar de teste: monta `FieldValues` para o tipo de nota padrao
    /// ("Basico": Frente/Verso). O contrato de producao e por NOME; isto so
    /// evita espalhar `HashMap::from` por trinta linhas de teste.
    fn frente_verso(frente: &str, verso: &str) -> FieldValues {
        campos(&[("Frente", frente), ("Verso", verso)])
    }

    fn campos(pares: &[(&str, &str)]) -> FieldValues {
        pares.iter().map(|(nome, valor)| ((*nome).to_string(), (*valor).to_string())).collect()
    }

    use std::path::{Path, PathBuf};

    use super::*;
    use crate::db::decks::DeckRepository;
    use crate::db::pool::connect_and_migrate;

    fn temp_database_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("learno-notes-test-{label}-{}.sqlite", Uuid::new_v4()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let mut wal = path.as_os_str().to_os_string();
        wal.push("-wal");
        let _ = std::fs::remove_file(wal);
        let mut shm = path.as_os_str().to_os_string();
        shm.push("-shm");
        let _ = std::fs::remove_file(shm);
    }

    #[test]
    fn build_field_values_json_zips_names_and_values_in_order() {
        let names = vec!["Frente".to_string(), "Verso".to_string()];
        let values = frente_verso("Mitocôndria", "Organela");

        let json = build_field_values_json(&names, &values).unwrap();
        assert_eq!(json, serde_json::json!({ "Frente": "Mitocôndria", "Verso": "Organela" }));
    }

    #[test]
    fn build_field_values_json_recusa_campo_que_nao_existe_no_tipo() {
        let names = vec!["Frente".to_string(), "Verso".to_string()];
        let values = campos(&[("Fente", "typo")]);

        let err = build_field_values_json(&names, &values).unwrap_err();
        let message = err.to_string();
        assert!(message.contains("Fente"), "a mensagem devia citar o campo errado: {message}");
        assert!(message.contains("Frente"), "e listar os validos: {message}");
    }

    #[test]
    fn template_count_reads_the_array_length() {
        let templates = serde_json::json!([{ "name": "a" }, { "name": "b" }]);
        assert_eq!(template_count(&templates).unwrap(), 2);
    }

    #[test]
    fn template_count_rejects_a_non_array() {
        assert!(template_count(&serde_json::json!("não é array")).is_err());
    }

    #[tokio::test]
    async fn list_note_types_seeds_the_four_built_ins_exactly_once() {
        let db_path = temp_database_path("seed-default");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let repo = NoteTypeRepository::new(pool.clone());

        let first_call = repo.list().await.unwrap();
        let mut nomes: Vec<&str> = first_call.iter().map(|tipo| tipo.name.as_str()).collect();
        nomes.sort_unstable();
        assert_eq!(
            nomes,
            vec![
                BASICO_NOTE_TYPE_NAME,
                CLOZE_NOTE_TYPE_NAME,
                DIGITAR_RESPOSTA_NOTE_TYPE_NAME,
                MULTIPLA_ESCOLHA_NOTE_TYPE_NAME,
            ],
            "instalação nova devia semear os quatro tipos embutidos"
        );

        let cloze = first_call.iter().find(|tipo| tipo.name == CLOZE_NOTE_TYPE_NAME).unwrap();
        assert_eq!(cloze.kind, NOTE_TYPE_KIND_CLOZE, "o tipo Cloze precisa nascer com kind = 'cloze'");
        let basico = first_call.iter().find(|tipo| tipo.name == BASICO_NOTE_TYPE_NAME).unwrap();
        assert_eq!(basico.kind, NOTE_TYPE_KIND_STANDARD, "um tipo padrão precisa nascer com kind = 'standard'");

        // Segunda chamada — nenhum `WHERE NOT EXISTS` pode duplicar nenhum dos quatro.
        let second_call = repo.list().await.unwrap();
        assert_eq!(second_call.len(), 4, "chamar de novo não pode semear nenhum tipo em duplicidade");
        let mut ids_primeira: Vec<Uuid> = first_call.iter().map(|tipo| tipo.id).collect();
        let mut ids_segunda: Vec<Uuid> = second_call.iter().map(|tipo| tipo.id).collect();
        ids_primeira.sort_unstable();
        ids_segunda.sort_unstable();
        assert_eq!(ids_primeira, ids_segunda, "os mesmos quatro ids, não substitutos");

        pool.close().await;
        cleanup(&db_path);
    }

    /// O caminho de atualização (rule 6, caso de borda que o teto padrão de
    /// campos permite mas o caminho feliz acima nunca vê): um banco que já
    /// existia ANTES desta peça, com "Básico" sozinho — o único jeito de
    /// provar que a checagem "por nome" (não "tabela vazia") de verdade
    /// resolve o problema que motivou a mudança.
    #[tokio::test]
    async fn list_note_types_adds_the_two_new_types_to_a_database_that_only_had_basico() {
        let db_path = temp_database_path("seed-upgrade-from-basico-only");
        let pool = connect_and_migrate(&db_path).await.unwrap();

        // Simula o estado de produção anterior a esta peça: só "Básico",
        // inserido diretamente (sem passar por `ensure_default`, que já
        // semearia os três).
        let id_legado = Uuid::now_v7();
        sqlx::query("INSERT INTO note_types (id, name, fields, templates) VALUES ($1, $2, $3, $4)")
            .bind(id_legado.db())
            .bind(BASICO_NOTE_TYPE_NAME)
            .bind(serde_json::json!(["Frente", "Verso"]))
            .bind(serde_json::json!([{ "name": "Cartão 1", "front": "{{Frente}}", "back": "{{Verso}}" }]))
            .execute(&pool)
            .await
            .unwrap();

        let repo = NoteTypeRepository::new(pool.clone());
        let tipos = repo.list().await.unwrap();

        assert_eq!(tipos.len(), 4, "os três tipos novos precisam ser somados ao Básico legado, não substituí-lo");
        let basico = tipos.iter().find(|tipo| tipo.name == BASICO_NOTE_TYPE_NAME).unwrap();
        assert_eq!(basico.id, id_legado, "o Básico existente não pode ser recriado com um id novo");
        assert_eq!(basico.kind, NOTE_TYPE_KIND_STANDARD, "kind precisa vir do DEFAULT da coluna para uma linha legada");
        assert!(tipos.iter().any(|tipo| tipo.name == DIGITAR_RESPOSTA_NOTE_TYPE_NAME));
        assert!(tipos.iter().any(|tipo| tipo.name == MULTIPLA_ESCOLHA_NOTE_TYPE_NAME));
        assert!(tipos.iter().any(|tipo| tipo.name == CLOZE_NOTE_TYPE_NAME));

        pool.close().await;
        cleanup(&db_path);
    }

    /// Cada um dos três tipos embutidos produz exatamente UM cartão por
    /// nota — mesma garantia de `create_note_generates_one_card_per_template`,
    /// agora para os dois tipos novos também.
    #[tokio::test]
    async fn create_note_works_for_digitar_resposta_and_multipla_escolha() {
        let db_path = temp_database_path("create-note-novos-tipos");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let deck = DeckRepository::new(pool.clone()).create(None, "Inglês").await.unwrap();
        let tipos = NoteTypeRepository::new(pool.clone()).list().await.unwrap();
        let repo = NoteRepository::new(pool.clone());

        let digitar = tipos.iter().find(|tipo| tipo.name == DIGITAR_RESPOSTA_NOTE_TYPE_NAME).unwrap();
        let nota_digitar =
            repo.create(deck.id, digitar.id, frente_verso("late", "atrasado"), vec![]).await.unwrap();
        assert_eq!(nota_digitar.field_values, serde_json::json!({ "Frente": "late", "Verso": "atrasado" }));

        let multipla = tipos.iter().find(|tipo| tipo.name == MULTIPLA_ESCOLHA_NOTE_TYPE_NAME).unwrap();
        let nota_multipla = repo
            .create(
                deck.id,
                multipla.id,
                campos(&[
                    ("Pergunta", "Capital da França?"),
                    ("Correta", "Paris"),
                    ("Errada 1", "Lyon"),
                    ("Errada 2", "Marselha"),
                    ("Errada 3", "Nice"),
                ]),
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(nota_multipla.field_values["Correta"], serde_json::json!("Paris"));

        for nota in [&nota_digitar, &nota_multipla] {
            let card_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE note_id = ?").bind(nota.id.db()).fetch_one(&pool).await.unwrap();
            assert_eq!(card_count, 1, "cada tipo embutido tem exatamente um template, logo um cartão por nota");
        }

        pool.close().await;
        cleanup(&db_path);
    }

    /// O caso de borda que o comentário de [`MULTIPLA_ESCOLHA_NOTE_TYPE_NAME`]
    /// promete não rejeitar: só a alternativa correta preenchida.
    #[tokio::test]
    async fn create_note_multipla_escolha_aceita_so_a_alternativa_correta_preenchida() {
        let db_path = temp_database_path("multipla-escolha-so-correta");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let deck = DeckRepository::new(pool.clone()).create(None, "Programação").await.unwrap();
        let multipla = NoteTypeRepository::new(pool.clone())
            .list()
            .await
            .unwrap()
            .into_iter()
            .find(|tipo| tipo.name == MULTIPLA_ESCOLHA_NOTE_TYPE_NAME)
            .unwrap();
        let repo = NoteRepository::new(pool.clone());

        let nota = repo
            .create(deck.id, multipla.id, campos(&[("Pergunta", "O que é um borrow checker?"), ("Correta", "Verificador em tempo de compilação")]), vec![])
            .await
            .unwrap();

        assert_eq!(nota.field_values["Errada 1"], serde_json::json!(""), "alternativa não dada vira string vazia, não erro");

        pool.close().await;
        cleanup(&db_path);
    }

    async fn setup_deck_and_note_type(pool: &SqlitePool) -> (Uuid, Uuid) {
        let deck = DeckRepository::new(pool.clone()).create(None, "Biologia").await.unwrap();
        let note_type = NoteTypeRepository::new(pool.clone()).list().await.unwrap().into_iter().next().unwrap();
        (deck.id, note_type.id)
    }

    /// O ponto central deste arquivo: criar uma nota gera um cartão por
    /// template do tipo de nota, na mesma transação.
    #[tokio::test]
    async fn create_note_generates_one_card_per_template() {
        let db_path = temp_database_path("create-generates-cards");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let note = repo
            .create(deck_id, note_type_id, frente_verso("Mitocôndria", "Organela"), vec!["biologia".into()])
            .await
            .unwrap();
        assert_eq!(note.field_values, serde_json::json!({ "Frente": "Mitocôndria", "Verso": "Organela" }));
        assert_eq!(note.tags, serde_json::json!(["biologia"]));

        let card_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE note_id = ?")
            .bind(note.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        // O tipo de nota padrão ("Básico") tem exatamente um template.
        assert_eq!(card_count, 1);

        let card_state: String = sqlx::query_scalar("SELECT state FROM cards WHERE note_id = ?")
            .bind(note.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(card_state, "new");

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn create_note_rejects_an_unknown_field_without_writing_anything() {
        let db_path = temp_database_path("create-mismatch");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        // "Básico" tem os campos Frente/Verso. Um nome que não existe é erro de
        // chamador, e precisa falhar ALTO: aceitar em silêncio gravaria a nota
        // sem o conteúdo que o usuário digitou.
        //
        // Mandar só a Frente, por outro lado, passou a ser LEGÍTIMO com o
        // contrato por nome (o Verso vira string vazia) — é uma nota em
        // rascunho, que o Anki também aceita. O teste logo abaixo cobre esse
        // caso, e o único que continua barrado é a nota inteiramente vazia.
        let result = repo.create(deck_id, note_type_id, campos(&[("Fente", "typo no nome")]), vec![]).await;
        assert!(matches!(result, Err(Error::Invalid(_))));

        let note_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes").fetch_one(&pool).await.unwrap();
        assert_eq!(note_count, 0, "uma criação rejeitada não pode deixar nota nenhuma para trás");

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn create_note_aceita_so_um_campo_preenchido_e_completa_o_resto() {
        let db_path = temp_database_path("create-parcial");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let note = repo
            .create(deck_id, note_type_id, campos(&[("Frente", "Mitocôndria")]), vec![])
            .await
            .unwrap();

        assert_eq!(note.field_values, serde_json::json!({ "Frente": "Mitocôndria", "Verso": "" }));

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn create_note_rejects_a_trashed_deck() {
        let db_path = temp_database_path("create-trashed-deck");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_note_type(&pool).await;
        DeckRepository::new(pool.clone()).trash(deck_id).await.unwrap();
        let repo = NoteRepository::new(pool.clone());

        let result = repo.create(deck_id, note_type_id, frente_verso("a", "b"), vec![]).await;
        assert!(matches!(result, Err(Error::Invalid(_))));

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn create_note_reports_not_found_for_an_unknown_note_type() {
        let db_path = temp_database_path("create-unknown-note-type");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let deck = DeckRepository::new(pool.clone()).create(None, "Biologia").await.unwrap();
        let repo = NoteRepository::new(pool.clone());

        let result = repo.create(deck.id, Uuid::now_v7(), frente_verso("a", "b"), vec![]).await;
        assert!(matches!(result, Err(Error::NotFound(_))));

        pool.close().await;
        cleanup(&db_path);
    }

    /// Editar não pode recriar (nem apagar) os cartões que já existem.
    #[tokio::test]
    async fn update_note_changes_fields_without_touching_its_cards() {
        let db_path = temp_database_path("update-preserves-cards");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let note = repo.create(deck_id, note_type_id, frente_verso("a", "b"), vec![]).await.unwrap();
        let card_id_before: Uuid = sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
            .bind(note.id.db())
            .fetch_one(&pool)
            .await
            .unwrap()
            .into();

        let updated = repo.update(note.id, frente_verso("a-editado", "b-editado"), vec!["tag".into()]).await.unwrap();
        assert_eq!(updated.field_values, serde_json::json!({ "Frente": "a-editado", "Verso": "b-editado" }));

        let card_count_after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE note_id = ?").bind(note.id.db()).fetch_one(&pool).await.unwrap();
        assert_eq!(card_count_after, 1, "editar não pode recriar nem apagar o cartão existente");

        let card_id_after: Uuid = sqlx::query_scalar::<_, DbId>("SELECT id FROM cards WHERE note_id = ?")
            .bind(note.id.db())
            .fetch_one(&pool)
            .await
            .unwrap()
            .into();
        assert_eq!(card_id_before, card_id_after, "o cartão precisa continuar sendo o MESMO, não um substituto");

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn update_note_rejects_a_trashed_note() {
        let db_path = temp_database_path("update-trashed");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let note = repo.create(deck_id, note_type_id, frente_verso("a", "b"), vec![]).await.unwrap();
        repo.delete(note.id).await.unwrap();

        let result = repo.update(note.id, frente_verso("x", "y"), vec![]).await;
        assert!(matches!(result, Err(Error::Invalid(_))));

        pool.close().await;
        cleanup(&db_path);
    }

    /// Apagar suspende os cartões (preservando `review_log`) em vez de
    /// apagá-los — ver o comentário de `NoteRepository::delete`.
    #[tokio::test]
    async fn delete_note_soft_deletes_and_suspends_its_cards() {
        let db_path = temp_database_path("delete-suspends-cards");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let note = repo.create(deck_id, note_type_id, frente_verso("a", "b"), vec![]).await.unwrap();
        repo.delete(note.id).await.unwrap();

        let deleted_at: Option<String> =
            sqlx::query_scalar("SELECT deleted_at FROM notes WHERE id = ?").bind(note.id.db()).fetch_one(&pool).await.unwrap();
        assert!(deleted_at.is_some());

        let card_state: String =
            sqlx::query_scalar("SELECT state FROM cards WHERE note_id = ?").bind(note.id.db()).fetch_one(&pool).await.unwrap();
        assert_eq!(card_state, "suspended");

        let card_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE note_id = ?").bind(note.id.db()).fetch_one(&pool).await.unwrap();
        assert_eq!(card_count, 1, "suspender não é apagar — o cartão continua existindo");

        let second_attempt = repo.delete(note.id).await;
        assert!(matches!(second_attempt, Err(Error::Invalid(_))));

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn list_notes_filters_by_deck_and_excludes_trashed_notes() {
        let db_path = temp_database_path("list-filters");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let note_type = NoteTypeRepository::new(pool.clone()).list().await.unwrap().into_iter().next().unwrap();
        let deck_repo = DeckRepository::new(pool.clone());
        let deck_a = deck_repo.create(None, "Deck A").await.unwrap();
        let deck_b = deck_repo.create(None, "Deck B").await.unwrap();
        let repo = NoteRepository::new(pool.clone());

        let note_a = repo.create(deck_a.id, note_type.id, frente_verso("a1", "a2"), vec![]).await.unwrap();
        let note_b = repo.create(deck_b.id, note_type.id, frente_verso("b1", "b2"), vec![]).await.unwrap();
        repo.delete(note_a.id).await.unwrap();

        // Deck A: a única nota estava trashed, então a lista fica vazia.
        let deck_a_notes = repo.list(Some(deck_a.id), 10, 0).await.unwrap();
        assert!(deck_a_notes.is_empty());

        // Sem filtro de deck: só a nota B ativa aparece.
        let all_notes = repo.list(None, 10, 0).await.unwrap();
        assert_eq!(all_notes.len(), 1);
        assert_eq!(all_notes[0].id, note_b.id);

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn list_notes_rejects_negative_limit_or_offset() {
        let db_path = temp_database_path("list-negative");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let repo = NoteRepository::new(pool.clone());

        assert!(matches!(repo.list(None, -1, 0).await, Err(Error::Invalid(_))));
        assert!(matches!(repo.list(None, 0, -1).await, Err(Error::Invalid(_))));

        pool.close().await;
        cleanup(&db_path);
    }

    // ======================================================================
    // Cloze — as três perguntas da bar desta peça, cada uma com teste.
    // ======================================================================

    /// Açúcar de teste: monta `FieldValues` para o tipo "Cloze" (campo
    /// `Texto`, `Extra` fica vazio).
    fn cloze_campos(texto: &str) -> FieldValues {
        campos(&[("Texto", texto)])
    }

    async fn setup_deck_and_cloze_note_type(pool: &SqlitePool) -> (Uuid, Uuid) {
        let deck = DeckRepository::new(pool.clone()).create(None, "Cloze").await.unwrap();
        let cloze = NoteTypeRepository::new(pool.clone())
            .list()
            .await
            .unwrap()
            .into_iter()
            .find(|tipo| tipo.name == CLOZE_NOTE_TYPE_NAME)
            .unwrap();
        (deck.id, cloze.id)
    }

    /// Números de lacuna não-contíguos (`c1` e `c5`, sem os do meio) geram
    /// exatamente dois cartões, um por número — nunca cinco.
    #[tokio::test]
    async fn create_note_cloze_gera_um_cartao_por_numero_de_lacuna_e_ordinais_nao_precisam_ser_contiguos() {
        let db_path = temp_database_path("cloze-create");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_cloze_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let note = repo
            .create(deck_id, note_type_id, cloze_campos("{{c1::Paris}} é a capital da {{c5::França}}"), vec![])
            .await
            .unwrap();

        let mut ordinais: Vec<i64> =
            sqlx::query_scalar("SELECT template_ordinal FROM cards WHERE note_id = ?").bind(note.id.db()).fetch_all(&pool).await.unwrap();
        ordinais.sort_unstable();
        assert_eq!(ordinais, vec![1, 5], "c1 e c5 sem os do meio geram dois cartões, não cinco");

        pool.close().await;
        cleanup(&db_path);
    }

    #[tokio::test]
    async fn create_note_cloze_rejects_texto_sem_nenhuma_lacuna_sem_escrever_nada() {
        let db_path = temp_database_path("cloze-sem-lacuna");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_cloze_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let result = repo.create(deck_id, note_type_id, cloze_campos("nada de lacuna aqui"), vec![]).await;
        assert!(matches!(result, Err(Error::Invalid(_))));

        let note_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes").fetch_one(&pool).await.unwrap();
        assert_eq!(note_count, 0, "a rejeição precisa acontecer antes de qualquer escrita");

        pool.close().await;
        cleanup(&db_path);
    }

    /// Bar, pergunta 1: acrescentar uma lacuna nova numa edição precisa criar
    /// o cartão correspondente.
    #[tokio::test]
    async fn update_note_cloze_acrescentar_lacuna_cria_o_cartao_correspondente() {
        let db_path = temp_database_path("cloze-update-add");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_cloze_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let note = repo.create(deck_id, note_type_id, cloze_campos("{{c1::a}} e {{c2::b}}"), vec![]).await.unwrap();

        repo.update(note.id, cloze_campos("{{c1::a}} e {{c2::b}} e agora {{c3::c}}"), vec![]).await.unwrap();

        let mut ordinais: Vec<i64> =
            sqlx::query_scalar("SELECT template_ordinal FROM cards WHERE note_id = ?").bind(note.id.db()).fetch_all(&pool).await.unwrap();
        ordinais.sort_unstable();
        assert_eq!(ordinais, vec![1, 2, 3], "a lacuna nova (c3) precisa ganhar um cartão");

        pool.close().await;
        cleanup(&db_path);
    }

    /// Bar, pergunta 2: remover uma lacuna orfaniza o cartão — decisão desta
    /// peça é SUSPENDER (mesmo idioma de `NoteRepository::delete`), nunca
    /// apagar (apagar cascatearia `review_log`).
    #[tokio::test]
    async fn update_note_cloze_remover_lacuna_suspende_o_cartao_orfao_sem_apagar() {
        let db_path = temp_database_path("cloze-update-remove");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_cloze_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let note = repo.create(deck_id, note_type_id, cloze_campos("{{c1::a}} e {{c2::b}}"), vec![]).await.unwrap();

        repo.update(note.id, cloze_campos("{{c1::a}} só, a segunda lacuna sumiu"), vec![]).await.unwrap();

        let card_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM cards WHERE note_id = ?").bind(note.id.db()).fetch_one(&pool).await.unwrap();
        assert_eq!(card_count, 2, "o cartão órfão continua existindo — suspender não é apagar");

        let (estado_c2, suspenso_em_c2): (String, Option<String>) = sqlx::query_as(
            "SELECT state, suspended_at FROM cards WHERE note_id = ? AND template_ordinal = 2",
        )
        .bind(note.id.db())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(estado_c2, "suspended", "a lacuna que sumiu do texto precisa sair da fila de estudo");
        assert!(suspenso_em_c2.is_some());

        let estado_c1: String = sqlx::query_scalar("SELECT state FROM cards WHERE note_id = ? AND template_ordinal = 1")
            .bind(note.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(estado_c1, "new", "a lacuna que sobreviveu não pode ser tocada");

        pool.close().await;
        cleanup(&db_path);
    }

    /// Bar, pergunta 3 — A NÃO NEGOCIÁVEL: um cartão que sobrevive a uma
    /// edição mantém `interval_days`/`ease_factor`/`fsrs_stability`/
    /// `fsrs_difficulty`/`fsrs_last_review_at`/`lapses`/`reps`/`due`
    /// IDÊNTICOS — relidos direto do banco (não da struct devolvida por
    /// `update`), exatamente como a bar exige.
    #[tokio::test]
    async fn update_note_cloze_cartao_que_sobrevive_mantem_agendamento_identico() {
        let db_path = temp_database_path("cloze-update-preserves-scheduling");
        let pool = connect_and_migrate(&db_path).await.unwrap();
        let (deck_id, note_type_id) = setup_deck_and_cloze_note_type(&pool).await;
        let repo = NoteRepository::new(pool.clone());

        let note = repo.create(deck_id, note_type_id, cloze_campos("{{c1::a}} e {{c2::b}}"), vec![]).await.unwrap();

        // Simula um cartão já estudado sob FSRS — os mesmos oito campos que a
        // bar desta peça proíbe uma edição de tocar.
        sqlx::query(
            "UPDATE cards SET state = 'review', due = '2026-10-01T00:00:00.000Z', interval_days = 7, \
                    ease_factor = 260, fsrs_stability = 12.5, fsrs_difficulty = 4.2, \
                    fsrs_last_review_at = '2026-09-01T00:00:00.000Z', lapses = 1, reps = 3 \
             WHERE note_id = ? AND template_ordinal = 1",
        )
        .bind(note.id.db())
        .execute(&pool)
        .await
        .unwrap();

        type ColunasDeAgendamento = (String, Option<String>, i64, i64, Option<f64>, Option<f64>, Option<String>, i64, i64);
        let consulta_agendamento = "SELECT state, due, interval_days, ease_factor, fsrs_stability, fsrs_difficulty, \
                    fsrs_last_review_at, lapses, reps \
             FROM cards WHERE note_id = ? AND template_ordinal = 1";

        let antes: ColunasDeAgendamento =
            sqlx::query_as(consulta_agendamento).bind(note.id.db()).fetch_one(&pool).await.unwrap();

        // Edição de verdade: troca o conteúdo de c1, ACRESCENTA c3, mantém c2
        // — não um no-op.
        repo.update(note.id, cloze_campos("{{c1::a-editado}} e {{c2::b}} e {{c3::c}}"), vec![]).await.unwrap();

        let depois: ColunasDeAgendamento =
            sqlx::query_as(consulta_agendamento).bind(note.id.db()).fetch_one(&pool).await.unwrap();

        assert_eq!(antes, depois, "editar a nota não pode tocar o agendamento de um cartão que sobrevive");

        // E o cartão novo (c3) nasce com o estado "nunca estudado" de sempre.
        let estado_c3: String = sqlx::query_scalar("SELECT state FROM cards WHERE note_id = ? AND template_ordinal = 3")
            .bind(note.id.db())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(estado_c3, "new");

        pool.close().await;
        cleanup(&db_path);
    }
}
