//! Resilience and data-portability features that cut across the product
//! areas rather than belonging to one: crash recovery for in-progress edits
//! (PLT-005), manual backup/restore of the whole Postgres database
//! (PLT-011), automatic periodic backup with retention (PLT-013), and
//! exporting a page's block tree to a standalone Markdown file (FUN-023).
//!
//! Every DB-touching call in here is a thin, separately-testable layer over
//! the pure logic in each submodule — see the module docs below for why.

pub mod autosave;
pub mod dump;
pub mod markdown_export;
pub mod schedule;

pub use autosave::{merge_after_crash, AutosaveJournal, JournalEntry, LastDurableSave};
pub use dump::{run_backup, run_restore};
pub use markdown_export::{
    default_export_file_name, export_page_to_markdown, fetch_page_blocks, sanitize_filename, ExportBlockRow,
};
pub use schedule::{
    trigger_risky_operation_backup, BackupTrigger, Cadence, ScheduleConfig, ScheduleManifest, ScheduledBackupRecord,
};
