//! Fractional indexing for sibling order — pages under a parent, blocks
//! under a page, database properties/views under a database, and so on.
//!
//! Moving a row (drag-reorder, reparenting) writes one `position` value that
//! sorts between its two new neighbours; it never touches the rest of the
//! list the way a renumbered integer `sort_order` would.
//!
//! The value is stored as the hex string `FractionalIndex::to_string()`
//! produces, whose lexicographic order matches the index's own order, so a
//! plain `ORDER BY position` in SQL is enough.

use fractional_index::FractionalIndex;

use crate::error::{Error, Result};

/// Parses a stored position back into a comparable index. A corrupt or
/// hand-edited value is treated as invalid input, never as a panic — this
/// text ultimately comes from a database row, which this layer must not trust
/// blindly.
pub fn parse(raw: &str) -> Result<FractionalIndex> {
    FractionalIndex::from_string(raw)
        .map_err(|err| Error::Invalid(format!("posição de ordenação corrompida: {err}")))
}

/// The position for the first row ever inserted into an (otherwise empty)
/// sibling list.
pub fn first() -> String {
    FractionalIndex::default().to_string()
}

/// A position strictly between `before` and `after`. Either bound is `None`
/// to mean "start of the list" / "end of the list"; both `None` yields the
/// same value as [`first`].
///
/// Returns [`Error::Invalid`] only if the caller passes `before >= after`,
/// which means the two supposed neighbours were not actually adjacent in
/// sibling order — a caller bug, not a possible outcome of normal use.
pub fn between(before: Option<&FractionalIndex>, after: Option<&FractionalIndex>) -> Result<String> {
    FractionalIndex::new(before, after)
        .map(|index| index.to_string())
        .ok_or_else(|| {
            Error::Invalid("intervalo de posição inválido: vizinhos fora de ordem".into())
        })
}

#[cfg(test)]
mod tests {
    // Rule 3 exempts `#[cfg(test)]` from the unwrap/expect ban; clippy's
    // lint does not know about that carve-out, so it is spelled out here.
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn first_position_round_trips_through_storage() {
        let stored = first();
        let parsed = parse(&stored).unwrap();

        assert_eq!(parsed.to_string(), stored);
    }

    #[test]
    fn between_two_neighbours_sorts_strictly_in_between() {
        let left = parse(&first()).unwrap();
        let right_raw = between(Some(&left), None).unwrap();
        let right = parse(&right_raw).unwrap();

        let middle_raw = between(Some(&left), Some(&right)).unwrap();
        let middle = parse(&middle_raw).unwrap();

        assert!(left < middle);
        assert!(middle < right);
        // The whole point of a fractional index: string order must agree
        // with the parsed order, since SQL only ever sees the string.
        assert!(first() < middle_raw);
        assert!(middle_raw < right_raw);
    }

    #[test]
    fn between_with_no_bounds_matches_first() {
        assert_eq!(between(None, None).unwrap(), first());
    }

    #[test]
    fn repeated_insertion_at_the_start_never_needs_renumbering() {
        // This is the property the whole module exists for: inserting N
        // items one-by-one at the head of the list is N independent writes,
        // each strictly less than the previous head, never a rewrite of the
        // rows already there.
        let mut head = parse(&first()).unwrap();
        let mut previous_raw = head.to_string();

        for _ in 0..50 {
            let new_raw = between(None, Some(&head)).unwrap();
            assert!(new_raw < previous_raw);
            previous_raw = new_raw.clone();
            head = parse(&new_raw).unwrap();
        }
    }

    #[test]
    fn between_rejects_neighbours_given_out_of_order() {
        let low = parse(&first()).unwrap();
        let high = parse(&between(Some(&low), None).unwrap()).unwrap();

        assert!(between(Some(&high), Some(&low)).is_err());
        assert!(between(Some(&low), Some(&low)).is_err());
    }

    #[test]
    fn parse_rejects_corrupt_input() {
        assert!(parse("not a valid fractional index").is_err());
        assert!(parse("").is_err());
    }
}
