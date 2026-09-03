//! Data layer: the Postgres pool and migration bootstrap (`pool`), sibling
//! ordering (`position`), the Fase 1 repositories (`pages`, `page_versions`,
//! `search`), and PLT-014's database integrity check (`integrity`). Every
//! other module reaches Postgres only through here.

pub mod integrity;
pub mod page_versions;
pub mod pages;
pub mod pool;
pub mod position;
pub mod search;

pub use integrity::{IntegrityReport, IntegrityRepository};
pub use page_versions::{PageVersionRepository, PageVersionRow, SnapshotReason};
pub use pages::{PageRepository, PageRow, SiblingPosition};
pub use pool::{connect_and_migrate, connect_migrate_with_rollback};
pub use search::{SearchRepository, SearchResultRow, DEFAULT_RESULT_LIMIT};
