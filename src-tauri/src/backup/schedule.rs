//! Automatic periodic backups with configurable retention, plus an
//! on-demand trigger for risky operations (PLT-013).
//!
//! This is deliberately layered like the rest of `backup`: the decisions
//! ("is a backup due right now?", "which old backups should be deleted?")
//! are pure functions below, each provable without touching disk or
//! Postgres; the only I/O is [`ScheduleManifest`], a small JSON file under
//! the app's data directory that remembers which files this scheduler
//! created and why — never the manual backups from PLT-011's `create_backup`,
//! which PLT-013's acceptance criterion keeps explicitly distinct ("distinto
//! do backup manual sob comando explícito").
//!
//! What this module does not do, and why: run itself unattended with no one
//! at the keyboard. `dump::run_backup` needs a live Postgres password, and
//! this codebase's config never persists one (`config::AppConfig` has no
//! password field, by design — see its module doc). So every function here
//! that actually spawns `pg_dump` still takes a `password` argument from a
//! caller that has one in memory; what this module adds is the *decision*
//! of whether that call should happen at all (`is_due`) and what to do with
//! the backups it accumulates (`select_prune_candidates`), so the caller
//! never has to reimplement either. See `ipc::backup_commands` for how the
//! two IPC commands built on top of this wire a password in.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::dump;
use crate::config::AppConfig;
use crate::error::{Error, Result};

/// Key, inside `config::STORE_FILE`, where the serialized [`ScheduleConfig`] lives.
pub const SCHEDULE_STORE_KEY: &str = "backup_schedule";

/// How often a cadence-triggered backup should repeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cadence {
    Daily,
    Weekly,
    Monthly,
}

impl Cadence {
    /// The minimum gap between two cadence-triggered backups. Calendar
    /// months vary in length; PLT-013's acceptance criterion only asks for
    /// "quando o intervalo... decorre", not calendar-month alignment, so a
    /// fixed 30-day period is the simplest rule that satisfies it without
    /// pulling in a calendar-arithmetic dependency for one constant.
    fn min_interval(self) -> Duration {
        match self {
            Cadence::Daily => Duration::days(1),
            Cadence::Weekly => Duration::days(7),
            Cadence::Monthly => Duration::days(30),
        }
    }
}

/// What the user configures for automatic backups: whether they run at all,
/// how often, and how many copies each trigger kind keeps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduleConfig {
    pub enabled: bool,
    pub cadence: Cadence,
    /// How many cadence-triggered backups (the periodic ones) survive pruning.
    pub keep_scheduled: u32,
    /// How many risky-operation-triggered backups survive pruning — its own
    /// count, per PLT-013's "distinto do backup manual" split applied one
    /// level further: cadence backups and risky-operation backups are two
    /// separate retention buckets, not one shared pool.
    pub keep_risky_operation: u32,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            cadence: Cadence::Daily,
            keep_scheduled: 7,
            keep_risky_operation: 5,
        }
    }
}

impl ScheduleConfig {
    pub fn validate(&self) -> Result<()> {
        if self.keep_scheduled == 0 {
            return Err(Error::Invalid(
                "retenção do backup automático precisa manter pelo menos 1 cópia".into(),
            ));
        }
        if self.keep_risky_operation == 0 {
            return Err(Error::Invalid(
                "retenção do backup por operação de risco precisa manter pelo menos 1 cópia".into(),
            ));
        }
        Ok(())
    }
}

/// Why a given scheduled backup was created — the two trigger kinds
/// PLT-013 asks for, each with its own retention bucket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackupTrigger {
    Cadence,
    /// `operation` is a short label ("import_colpkg", "check_database",
    /// "sync_one_way") for whoever reads the manifest later — this module
    /// does not validate it against a fixed list, since the features that
    /// will call this (none of which exist in this codebase yet — see
    /// `ipc::backup_commands` doc comment) are free to name themselves.
    RiskyOperation { operation: String },
}

/// One entry in the manifest: a backup this scheduler created, and why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduledBackupRecord {
    pub path: PathBuf,
    pub created_at: DateTime<Utc>,
    pub trigger: BackupTrigger,
}

/// True when enough time has passed since the last cadence-triggered backup
/// to run another one. Only `Cadence`-triggered records count as "the last
/// one" here — a risky-operation backup happening yesterday must never
/// postpone today's scheduled daily backup, since PLT-013 keeps the two
/// triggers' bookkeeping independent.
pub fn is_due(last_cadence_backup_at: Option<DateTime<Utc>>, cadence: Cadence, now: DateTime<Utc>) -> bool {
    match last_cadence_backup_at {
        None => true,
        Some(last) => now - last >= cadence.min_interval(),
    }
}

/// Given every record on file and the active policy, returns the ones that
/// should be deleted. Cadence and risky-operation records are pruned as two
/// separate buckets, each keeping only its own `keep_*` most recent entries
/// — an old daily backup being pruned never counts against how many
/// risky-operation backups survive, and vice versa.
pub fn select_prune_candidates(records: &[ScheduledBackupRecord], config: &ScheduleConfig) -> Vec<ScheduledBackupRecord> {
    let (cadence_records, risky_records): (Vec<_>, Vec<_>) = records
        .iter()
        .cloned()
        .partition(|record| matches!(record.trigger, BackupTrigger::Cadence));

    let mut pruned = prune_bucket(cadence_records, config.keep_scheduled);
    pruned.extend(prune_bucket(risky_records, config.keep_risky_operation));
    pruned
}

/// Newest-first within one bucket; everything past `keep` is returned for
/// pruning. `keep` as `u32` never negative, so the only edge case is a
/// bucket smaller than `keep` — `split_off` at or past the end is `vec![]`,
/// exactly "nothing to prune yet".
fn prune_bucket(mut records: Vec<ScheduledBackupRecord>, keep: u32) -> Vec<ScheduledBackupRecord> {
    records.sort_by_key(|record| std::cmp::Reverse(record.created_at));
    let keep = usize::try_from(keep).unwrap_or(usize::MAX);
    if records.len() <= keep {
        return Vec::new();
    }
    records.split_off(keep)
}

/// PLT-013's actual risky-operation trigger: runs a real `pg_dump` against
/// `config`/`password` into `backup_dir`, then records it in the manifest at
/// `manifest_path` under its own `keep_risky_operation` retention bucket —
/// the single choke point every risky-operation caller should go through
/// instead of calling `dump::run_backup` directly and losing PLT-013's
/// tracking/pruning entirely (which is exactly the gap PLT-013 named: the
/// cadence half of this module was reachable and tested, this half was not
/// reachable from anything).
///
/// `db::pool::connect_migrate_with_rollback` is the first real caller (a
/// schema migration about to run over established data); whichever IPC
/// command wires up `.apkg` import or a "Check Database" repair next should
/// call this too, each with its own `operation` label — this function
/// doesn't validate that string against a fixed list, same as
/// [`BackupTrigger::RiskyOperation`] above.
///
/// Returns `Err` — never a soft warning — when the backup itself fails, so
/// a caller that just propagates the error (as every current caller does)
/// cannot go on to run the risky operation while believing it is protected.
pub async fn trigger_risky_operation_backup(
    config: &AppConfig,
    password: &str,
    backup_dir: &Path,
    manifest_path: &Path,
    schedule_config: &ScheduleConfig,
    operation: &str,
) -> Result<PathBuf> {
    let path = dump::run_backup(config, password, backup_dir).await?;

    let manifest = ScheduleManifest::new(manifest_path);
    manifest.record(ScheduledBackupRecord {
        path: path.clone(),
        created_at: Utc::now(),
        trigger: BackupTrigger::RiskyOperation { operation: operation.to_string() },
    })?;
    manifest.prune(schedule_config)?;

    Ok(path)
}

/// The on-disk record of every backup this scheduler (as opposed to
/// PLT-011's manual `create_backup`) has created — one JSON array file, in
/// the same atomic-write-then-rename style as `autosave::AutosaveJournal`,
/// for the same reason: a crash mid-write must never leave a half-written
/// manifest that the next read chokes on.
pub struct ScheduleManifest {
    path: PathBuf,
}

impl ScheduleManifest {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Every record on file, oldest write order preserved. No file yet
    /// means no scheduled backup has ever run — not an error.
    pub fn load(&self) -> Result<Vec<ScheduledBackupRecord>> {
        match fs::read_to_string(&self.path) {
            Ok(raw) => Ok(serde_json::from_str(&raw)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error.into()),
        }
    }

    fn save(&self, records: &[ScheduledBackupRecord]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let serialized = serde_json::to_vec_pretty(records)?;
        let tmp_path = self.path.with_extension("json.tmp");
        fs::write(&tmp_path, &serialized)?;
        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }

    /// Appends one record after a scheduled backup was just created.
    pub fn record(&self, record: ScheduledBackupRecord) -> Result<()> {
        let mut records = self.load()?;
        records.push(record);
        self.save(&records)
    }

    /// The most recent `Cadence`-triggered backup's timestamp, or `None`
    /// when the scheduler has never run one yet — [`is_due`]'s input.
    pub fn last_cadence_backup_at(&self) -> Result<Option<DateTime<Utc>>> {
        let records = self.load()?;
        Ok(records
            .iter()
            .filter(|record| matches!(record.trigger, BackupTrigger::Cadence))
            .map(|record| record.created_at)
            .max())
    }

    /// Runs [`select_prune_candidates`] against the current manifest,
    /// deletes each pruned backup's file from disk, and rewrites the
    /// manifest without them. A file already missing from disk is not an
    /// error — the same "already clear is not a failure" rule
    /// `AutosaveJournal::clear_pending` uses — since a user manually
    /// deleting an old backup file must never block pruning the rest.
    pub fn prune(&self, config: &ScheduleConfig) -> Result<Vec<ScheduledBackupRecord>> {
        let records = self.load()?;
        let to_prune = select_prune_candidates(&records, config);
        let pruned_paths: HashSet<&PathBuf> = to_prune.iter().map(|record| &record.path).collect();

        for record in &to_prune {
            match fs::remove_file(&record.path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }

        let remaining: Vec<_> = records
            .into_iter()
            .filter(|record| !pruned_paths.contains(&record.path))
            .collect();
        self.save(&remaining)?;
        Ok(to_prune)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use uuid::Uuid;

    struct ScratchFile(PathBuf);

    impl ScratchFile {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!("learno-schedule-test-{label}-{}.json", Uuid::new_v4()));
            Self(path)
        }
    }

    impl Drop for ScratchFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    fn record(path: &str, created_at: DateTime<Utc>, trigger: BackupTrigger) -> ScheduledBackupRecord {
        ScheduledBackupRecord { path: PathBuf::from(path), created_at, trigger }
    }

    #[test]
    fn is_due_with_no_prior_backup_is_always_true() {
        assert!(is_due(None, Cadence::Daily, Utc::now()));
    }

    #[test]
    fn is_due_before_the_cadence_interval_elapsed_is_false() {
        let last = Utc::now() - Duration::hours(1);
        assert!(!is_due(Some(last), Cadence::Daily, Utc::now()));
    }

    #[test]
    fn is_due_after_the_cadence_interval_elapsed_is_true() {
        let last = Utc::now() - Duration::days(2);
        assert!(is_due(Some(last), Cadence::Daily, Utc::now()));
    }

    #[test]
    fn is_due_uses_a_longer_interval_for_weekly_than_daily() {
        let last = Utc::now() - Duration::days(2);
        assert!(is_due(Some(last), Cadence::Daily, Utc::now()));
        assert!(!is_due(Some(last), Cadence::Weekly, Utc::now()));
    }

    #[test]
    fn select_prune_candidates_keeps_the_newest_n_per_bucket_and_drops_the_rest() {
        let now = Utc::now();
        let records = vec![
            record("a.dump", now - Duration::days(3), BackupTrigger::Cadence),
            record("b.dump", now - Duration::days(2), BackupTrigger::Cadence),
            record("c.dump", now - Duration::days(1), BackupTrigger::Cadence),
        ];
        let config = ScheduleConfig { keep_scheduled: 2, ..ScheduleConfig::default() };

        let pruned = select_prune_candidates(&records, &config);

        assert_eq!(pruned.len(), 1);
        assert_eq!(pruned[0].path, PathBuf::from("a.dump"));
    }

    #[test]
    fn select_prune_candidates_never_prunes_when_the_bucket_fits_within_retention() {
        let now = Utc::now();
        let records = vec![record("a.dump", now, BackupTrigger::Cadence)];
        let config = ScheduleConfig { keep_scheduled: 7, ..ScheduleConfig::default() };

        assert!(select_prune_candidates(&records, &config).is_empty());
    }

    #[test]
    fn select_prune_candidates_keeps_cadence_and_risky_operation_buckets_independent() {
        let now = Utc::now();
        let records = vec![
            record("cadence-old.dump", now - Duration::days(2), BackupTrigger::Cadence),
            record("cadence-new.dump", now, BackupTrigger::Cadence),
            record(
                "risky-old.dump",
                now - Duration::days(2),
                BackupTrigger::RiskyOperation { operation: "import_colpkg".into() },
            ),
        ];
        // Keeps only 1 of each bucket: the old cadence backup is pruned,
        // but the lone risky-operation backup survives even though it is
        // older than the pruned cadence one — the buckets never compete.
        let config = ScheduleConfig { keep_scheduled: 1, keep_risky_operation: 1, ..ScheduleConfig::default() };

        let pruned = select_prune_candidates(&records, &config);

        assert_eq!(pruned.len(), 1);
        assert_eq!(pruned[0].path, PathBuf::from("cadence-old.dump"));
    }

    #[test]
    fn schedule_config_rejects_zero_retention_in_either_bucket() {
        assert!(ScheduleConfig { keep_scheduled: 0, ..ScheduleConfig::default() }.validate().is_err());
        assert!(ScheduleConfig { keep_risky_operation: 0, ..ScheduleConfig::default() }.validate().is_err());
    }

    // A real `pg_dump` run needs a live Postgres (covered by the `#[ignore]`d
    // integration test in `tests/backup_dump.rs` and by `db::pool`'s own
    // `live_database` tests); what belongs here, with no database at all, is
    // proving the failure contract: when the underlying backup fails, this
    // function must return `Err` and must not touch the manifest — the
    // "never let the caller think it's protected" half of the requirement.
    #[tokio::test]
    async fn trigger_risky_operation_backup_reports_the_backup_failure_and_leaves_the_manifest_untouched() {
        let manifest_scratch = ScratchFile::new("trigger-failure");
        let backup_dir = std::env::temp_dir().join(format!("learno-trigger-backup-test-{}", Uuid::new_v4()));
        // A port nothing listens on, deliberately not 5432/5433 — this must
        // fail on its own merits (connection refused) without depending on,
        // or touching, whatever real Postgres happens to be reachable on
        // this machine.
        let config = AppConfig {
            host: "127.0.0.1".into(),
            port: 59999,
            database: "learno_nao_existe".into(),
            user: "postgres".into(),
        };

        let result = trigger_risky_operation_backup(
            &config,
            "unused",
            &backup_dir,
            &manifest_scratch.0,
            &ScheduleConfig::default(),
            "schema_migration",
        )
        .await;

        // `pg_dump` either isn't on this machine's PATH or has nothing to
        // connect to at `localhost:5432` under this made-up config — either
        // way it must fail, and this asserts the manifest never sees a
        // record for a backup that didn't actually happen.
        assert!(result.is_err(), "expected the backup itself to fail with no real Postgres to dump");
        assert!(!manifest_scratch.0.exists(), "a failed backup must not write a manifest record");

        let _ = fs::remove_dir_all(&backup_dir);
    }

    #[test]
    fn schedule_config_default_is_valid() {
        assert!(ScheduleConfig::default().validate().is_ok());
    }

    #[test]
    fn manifest_starts_empty_before_any_file_exists() {
        let scratch = ScratchFile::new("empty");
        let manifest = ScheduleManifest::new(&scratch.0);

        assert_eq!(manifest.load().unwrap(), Vec::new());
        assert_eq!(manifest.last_cadence_backup_at().unwrap(), None);
    }

    #[test]
    fn manifest_record_round_trips_and_tracks_the_latest_cadence_backup() {
        let scratch = ScratchFile::new("round-trip");
        let manifest = ScheduleManifest::new(&scratch.0);
        let now = Utc::now();

        manifest
            .record(record("first.dump", now - Duration::days(1), BackupTrigger::Cadence))
            .unwrap();
        manifest.record(record("second.dump", now, BackupTrigger::Cadence)).unwrap();

        let loaded = manifest.load().unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(manifest.last_cadence_backup_at().unwrap(), Some(now));
    }

    #[test]
    fn manifest_prune_deletes_pruned_files_and_rewrites_the_manifest_without_them() {
        let scratch = ScratchFile::new("prune");
        let manifest = ScheduleManifest::new(&scratch.0);
        let now = Utc::now();

        let old_file = std::env::temp_dir().join(format!("learno-schedule-prune-old-{}.dump", Uuid::new_v4()));
        let new_file = std::env::temp_dir().join(format!("learno-schedule-prune-new-{}.dump", Uuid::new_v4()));
        fs::write(&old_file, b"old").unwrap();
        fs::write(&new_file, b"new").unwrap();

        manifest
            .record(record(old_file.to_str().unwrap(), now - Duration::days(1), BackupTrigger::Cadence))
            .unwrap();
        manifest.record(record(new_file.to_str().unwrap(), now, BackupTrigger::Cadence)).unwrap();

        let config = ScheduleConfig { keep_scheduled: 1, ..ScheduleConfig::default() };
        let pruned = manifest.prune(&config).unwrap();

        assert_eq!(pruned.len(), 1);
        assert!(!old_file.exists());
        assert!(new_file.exists());
        assert_eq!(manifest.load().unwrap().len(), 1);

        let _ = fs::remove_file(&new_file);
    }

    #[test]
    fn manifest_prune_treats_an_already_missing_file_as_already_pruned() {
        let scratch = ScratchFile::new("prune-missing");
        let manifest = ScheduleManifest::new(&scratch.0);
        let now = Utc::now();

        let missing = std::env::temp_dir().join(format!("learno-schedule-already-gone-{}.dump", Uuid::new_v4()));
        manifest
            .record(record(missing.to_str().unwrap(), now - Duration::days(1), BackupTrigger::Cadence))
            .unwrap();
        manifest.record(record("kept.dump", now, BackupTrigger::Cadence)).unwrap();

        let config = ScheduleConfig { keep_scheduled: 1, ..ScheduleConfig::default() };
        let result = manifest.prune(&config);

        assert!(result.is_ok());
        assert_eq!(manifest.load().unwrap().len(), 1);
    }
}
