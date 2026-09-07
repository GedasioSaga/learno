//! Data layer: the SQLite pool and migration bootstrap (`pool`), sibling
//! ordering (`position`), the Fase 1 repositories (`pages`, `page_versions`,
//! `search`), PLT-014's database integrity check (`integrity`), and Fase 2's
//! block tree (`blocks`) with its backlink graph (`backlinks`). Every other
//! module reaches SQLite only through here.
//!
//! Fase 3 acrescenta: o caminho UNICO de escrita de valor de propriedade
//! (`record_values` — invariante I4 da arquitetura), o grafo de arestas de
//! relacao (`relations`, a unica excecao a "valor e linha em
//! database_record_values") e o motor de efeitos que template, botao,
//! automacao, edicao em lote e import de CSV compartilham (`effects`).

pub mod backlinks;
pub mod biblioteca;
pub mod biblioteca_categorias;
pub mod blocks;
pub mod cards;
pub mod cloze;
pub mod cronograma;
pub mod databases;
pub mod decks;
pub mod effects;
pub mod gamificacao;
pub mod ids;
pub mod integrity;
pub mod mindmap;
pub mod notes;
pub mod page_versions;
pub mod pages;
pub mod pagina_de_livro;
pub mod pomodoro;
pub mod pool;
pub mod position;
pub mod prazos;
pub mod record_values;
pub mod relations;
pub mod resumo_capitulo;
pub mod review_log;
pub mod search;
pub mod sql;
pub mod tags;
pub mod trilha;
pub mod vocabulario;

pub use backlinks::{BacklinkRepository, BacklinkRow, OutgoingLinkRow};
pub use biblioteca::{AnotacaoRow, BibliotecaRepository, LivroAberto, LivroNaEstante, LivroRow, ProgressoDeLeitura};
pub use biblioteca_categorias::{Categoria, CategoriaRepository, CategoriasDoLivro};
pub use blocks::{BlockChangeInput, BlockPatchInput, BlockPlacementInput, BlockRepository, BlockRow, NewBlockInput};
pub use cards::{AnswerOutcome, CardRepository, CardRow, CardToStudy, DeckCounts, DiaPrevisto};
pub use cronograma::{
    BlocoPatchInput, BlocoPlanejado, CronogramaRepository, DiaDaSemana, Materia, MateriaPatchInput, SemanaDeEstudo,
};
pub use databases::{
    DatabasePropertyRow, DatabaseRecord, DatabaseRepository, DatabaseRow, DatabaseViewRow, VALID_PROPERTY_TYPES,
    VALID_VIEW_TYPES,
};
pub use decks::{DeckRepository, DeckRow};
pub use effects::{
    BrokenReference, BrokenReferenceOwner, EffectExecutionContext, EffectOutcome, EffectRepository, MissingKind,
    OpenAfter, PropertyWrite, PropertyWriteOp, RecordEffect, ValueSource,
};
pub use gamificacao::{
    Desafio, EstadoDeNivel, GamificacaoRepository, MelhorDia, MelhorSemana, RecordesPessoais, ResumoDeSessao,
    XpEventRow, XP_POR_BLOCO_CRONOGRAMA, XP_POR_DESAFIO_DIARIO, XP_POR_POMODORO_CONCLUIDO, XP_POR_REVISAO_CARTAO,
};
pub use ids::{DbId, DbIdOpt, IdBind};
pub use integrity::{IntegrityReport, IntegrityRepository};
pub use mindmap::{
    MindmapChangeInput, MindmapEdgePatchInput, MindmapEdgeRow, MindmapGraph, MindmapNodePatchInput,
    MindmapNodePositionInput, MindmapNodeRow, MindmapRepository, MindmapRow, NewMindmapEdgeInput, NewMindmapNodeInput,
};
pub use notes::{FieldValues, NoteRepository, NoteRow, NoteTypeRepository, NoteTypeRow};
pub use page_versions::{PageVersionRepository, PageVersionRow, SnapshotReason};
pub use pages::{PageRepository, PageRow, SiblingPosition};
pub use pagina_de_livro::{PaginaDeLivro, PaginaDeLivroRepository};
pub use pomodoro::{PomodoroRepository, PomodoroResumo, PomodoroRow};
pub use pool::{connect_and_migrate, connect_migrate_with_rollback};
pub use prazos::{PrazoComContagem, PrazoPatchInput, PrazoRepository, PrazoRow, PrazosListados};
pub use record_values::{AppliedChanges, AppliedRecordValue, RecordValueChangeInput, RecordValueRepository, RecordValueRow};
pub use relations::{
    CreateRelationInput, CreateRelationResult, RecordTargets, RelationDefinitionRow, RelationRepository,
    RelationTargetPage, RelationTargetRow,
};
pub use resumo_capitulo::{ResumoCapituloRepository, ResumoDeCapitulo};
pub use review_log::{ReviewLogRepository, RevisaoDoDia, StudyStats};
pub use search::{SearchRepository, SearchResultRow, DEFAULT_RESULT_LIMIT};
pub use tags::{extract_tags, TagPageRow, TagRepository, TagSummaryRow};
pub use trilha::{
    avaliar_desbloqueio, ConfiguracaoTrilha, Decisao, Desbloqueio, Etapa, Flecha, ImpactoDaTroca, MaterialDaEtapa,
    NivelTopologico, ProgressoDaEtapa, Raia, SituacaoNoCaminho, Trilha, TrilhaRepository, TrilhaResumo,
};
pub use vocabulario::{PalavraColetada, VocabularioRepository};
