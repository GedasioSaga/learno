//! Crash recovery for in-progress edits (PLT-005).
//!
//! FUN-034 already snapshots a page's content to `page_versions` every 10
//! minutes while the user edits — but a crash between two of those snapshots
//! would still lose up to 10 minutes of work. This journal exists to close
//! that gap: the editor calls [`AutosaveJournal::write_pending`] far more
//! often (every few seconds of idle typing), to a plain file on disk, and
//! [`AutosaveJournal::clear_pending`] the moment that content is confirmed
//! durably saved to SQLite.
//!
//! The key invariant, and the reason this needs no separate "was the last
//! session dirty?" marker: a journal entry for a page exists on disk **only
//! while that page's edits have not yet been confirmed saved**. So finding
//! one at startup (via [`AutosaveJournal::list_pending`]) already *is* the
//! dirty-session signal — the previous process ended (crashed) before it
//! ever got to call `clear_pending`. A clean shutdown always clears first.
//!
//! Nothing here touches SQLite, so every test in this file runs with no
//! database at all — only a scratch directory on disk.

use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Result;

/// One page's not-yet-confirmed edit, as written to `<page_id>.json` under
/// the journal directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub page_id: Uuid,
    pub title: String,
    pub content: serde_json::Value,
    pub captured_at: DateTime<Utc>,
}

/// The most recent point in time this page's content is known to have
/// reached SQLite durably — the baseline a recovered journal entry is
/// compared against, so a stale entry never overwrites a save that already
/// happened after it (a narrow race: autosave-to-DB succeeds, then the
/// process dies before the journal file is cleared).
#[derive(Debug, Clone, Copy)]
pub struct LastDurableSave {
    pub saved_at: DateTime<Utc>,
}

/// Reads and writes the on-disk journal directory. One JSON file per page
/// that currently has unconfirmed edits; no file means nothing to recover.
pub struct AutosaveJournal {
    base_dir: PathBuf,
}

impl AutosaveJournal {
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self { base_dir: base_dir.into() }
    }

    /// Writes (or replaces) the pending edit for `page_id`. Called on a
    /// short timer while the user edits — much more often than FUN-034's
    /// 10-minute version snapshot.
    ///
    /// Writes to a `.tmp` sibling and renames it into place rather than
    /// writing the final path directly: a rename on the same volume is
    /// effectively atomic, so a crash mid-write leaves either the old
    /// complete entry or the harmless `.tmp` file — never a half-written
    /// `.json` that `list_pending` would have to fail on.
    pub fn write_pending(&self, page_id: Uuid, title: &str, content: serde_json::Value) -> Result<()> {
        fs::create_dir_all(&self.base_dir)?;

        let entry = JournalEntry {
            page_id,
            title: title.to_string(),
            content,
            captured_at: Utc::now(),
        };
        let serialized = serde_json::to_vec_pretty(&entry)?;

        let tmp_path = self.tmp_path(page_id);
        fs::write(&tmp_path, &serialized)?;
        fs::rename(&tmp_path, self.entry_path(page_id))?;
        Ok(())
    }

    /// Reads back the pending edit for one page, if any.
    pub fn read_pending(&self, page_id: Uuid) -> Result<Option<JournalEntry>> {
        match fs::read_to_string(self.entry_path(page_id)) {
            Ok(raw) => Ok(Some(serde_json::from_str(&raw)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Drops the pending edit for `page_id`. Called right after that
    /// content is confirmed durably saved — from then on there is nothing
    /// left to recover for this page. Already being clear is not an error:
    /// a caller retrying after a partial failure should not have to check
    /// first.
    pub fn clear_pending(&self, page_id: Uuid) -> Result<()> {
        match fs::remove_file(self.entry_path(page_id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Every page with an unconfirmed edit sitting on disk — called once at
    /// startup to detect a previous session that ended without saving.
    ///
    /// A single corrupted entry (e.g. a `.tmp` that never got renamed, or a
    /// file truncated by the very crash we're recovering from) is skipped
    /// rather than failing the whole scan: one bad file must never hide
    /// every other page's recoverable content.
    pub fn list_pending(&self) -> Result<Vec<JournalEntry>> {
        let entries = match fs::read_dir(&self.base_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };

        let mut recovered = Vec::new();
        for dir_entry in entries {
            let path = dir_entry?.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }

            match fs::read_to_string(&path).map(|raw| serde_json::from_str::<JournalEntry>(&raw)) {
                Ok(Ok(entry)) => recovered.push(entry),
                Ok(Err(parse_error)) => {
                    tracing::warn!(path = %path.display(), error = %parse_error, "descartando entrada de diário de autosave corrompida");
                }
                Err(io_error) => {
                    tracing::warn!(path = %path.display(), error = %io_error, "não foi possível ler entrada de diário de autosave");
                }
            }
        }
        Ok(recovered)
    }

    fn entry_path(&self, page_id: Uuid) -> PathBuf {
        self.base_dir.join(format!("{page_id}.json"))
    }

    fn tmp_path(&self, page_id: Uuid) -> PathBuf {
        self.base_dir.join(format!("{page_id}.json.tmp"))
    }
}

/// True when `entry` postdates the last confirmed durable save — the guard
/// against the narrow race described on [`LastDurableSave`].
pub fn is_recovery_newer(entry: &JournalEntry, last_saved: Option<&LastDurableSave>) -> bool {
    match last_saved {
        None => true,
        Some(saved) => entry.captured_at > saved.saved_at,
    }
}

/// The merge step run when the app reopens after a crash: given the
/// recovered journal entry and (if any) the last confirmed save, decides
/// whether the recovered content should actually be offered to the user.
pub fn merge_after_crash(entry: JournalEntry, last_saved: Option<LastDurableSave>) -> Option<JournalEntry> {
    if is_recovery_newer(&entry, last_saved.as_ref()) {
        Some(entry)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use serde_json::json;

    /// Removes its directory on drop, including on a panicking assertion —
    /// so a failing test never leaves scratch files behind for the next run.
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("learno-autosave-test-{label}-{}", Uuid::new_v4()));
            Self(dir)
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn crash_mid_edit_recovers_the_content_that_was_never_confirmed_saved() {
        let scratch = ScratchDir::new("crash-recovers");
        let page_id = Uuid::now_v7();

        {
            // First "process": the user types, the journal gets a pending
            // entry, and then the process ends here without ever calling
            // `clear_pending` — simulating a crash mid-edit.
            let journal = AutosaveJournal::new(&scratch.0);
            journal
                .write_pending(page_id, "Minha Página", json!({"text": "rascunho não salvo"}))
                .unwrap();
        }

        // Second "process": the app reopens over the same directory.
        let reopened = AutosaveJournal::new(&scratch.0);
        let pending = reopened.list_pending().unwrap();

        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].page_id, page_id);
        assert_eq!(pending[0].title, "Minha Página");
        assert_eq!(pending[0].content, json!({"text": "rascunho não salvo"}));

        let recovered = merge_after_crash(pending[0].clone(), None);
        assert_eq!(recovered, Some(pending[0].clone()));
    }

    #[test]
    fn a_clean_shutdown_that_clears_the_journal_leaves_nothing_to_recover() {
        let scratch = ScratchDir::new("clean-shutdown");
        let page_id = Uuid::now_v7();

        let journal = AutosaveJournal::new(&scratch.0);
        journal.write_pending(page_id, "Página Salva", json!({"text": "ok"})).unwrap();
        journal.clear_pending(page_id).unwrap();

        let reopened = AutosaveJournal::new(&scratch.0);
        assert!(reopened.list_pending().unwrap().is_empty());
    }

    #[test]
    fn clearing_a_page_with_no_pending_entry_is_not_an_error() {
        let scratch = ScratchDir::new("clear-noop");
        let journal = AutosaveJournal::new(&scratch.0);

        assert!(journal.clear_pending(Uuid::now_v7()).is_ok());
    }

    #[test]
    fn listing_pending_entries_before_the_journal_directory_ever_existed_is_empty_not_an_error() {
        let scratch = ScratchDir::new("never-created");
        let journal = AutosaveJournal::new(&scratch.0);

        assert_eq!(journal.list_pending().unwrap(), Vec::new());
    }

    #[test]
    fn a_corrupted_journal_file_is_skipped_instead_of_failing_the_whole_scan() {
        let scratch = ScratchDir::new("corrupt-entry");
        fs::create_dir_all(&scratch.0).unwrap();

        // A garbage file next to a real, valid entry: the crash that
        // produced the corrupt one must not hide the other page's recovery.
        fs::write(scratch.0.join("not-json.json"), b"{ this is not valid json").unwrap();

        let journal = AutosaveJournal::new(&scratch.0);
        let good_page = Uuid::now_v7();
        journal.write_pending(good_page, "Boa", json!({"text": "ok"})).unwrap();

        let pending = journal.list_pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].page_id, good_page);
    }

    #[test]
    fn a_leftover_tmp_file_from_an_interrupted_write_is_ignored() {
        let scratch = ScratchDir::new("leftover-tmp");
        fs::create_dir_all(&scratch.0).unwrap();
        fs::write(scratch.0.join(format!("{}.json.tmp", Uuid::now_v7())), b"partial").unwrap();

        let journal = AutosaveJournal::new(&scratch.0);
        assert!(journal.list_pending().unwrap().is_empty());
    }

    #[test]
    fn a_journal_entry_older_than_the_last_durable_save_is_not_offered_for_recovery() {
        let page_id = Uuid::now_v7();
        let older = Utc::now() - chrono::Duration::minutes(5);
        let newer = Utc::now();

        let entry = JournalEntry {
            page_id,
            title: "Página".into(),
            content: json!({"text": "velho"}),
            captured_at: older,
        };
        let last_saved = LastDurableSave { saved_at: newer };

        assert_eq!(merge_after_crash(entry, Some(last_saved)), None);
    }

    #[test]
    fn a_journal_entry_newer_than_the_last_durable_save_is_offered_for_recovery() {
        let page_id = Uuid::now_v7();
        let older = Utc::now() - chrono::Duration::minutes(5);
        let newer = Utc::now();

        let entry = JournalEntry {
            page_id,
            title: "Página".into(),
            content: json!({"text": "novo"}),
            captured_at: newer,
        };
        let last_saved = LastDurableSave { saved_at: older };

        assert_eq!(merge_after_crash(entry.clone(), Some(last_saved)), Some(entry));
    }

    #[test]
    fn writing_twice_replaces_the_pending_entry_rather_than_accumulating() {
        let scratch = ScratchDir::new("overwrite");
        let page_id = Uuid::now_v7();
        let journal = AutosaveJournal::new(&scratch.0);

        journal.write_pending(page_id, "V1", json!({"text": "primeira"})).unwrap();
        journal.write_pending(page_id, "V2", json!({"text": "segunda"})).unwrap();

        let pending = journal.list_pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].title, "V2");
    }
}
