//! C6 REM candidate and graph selection over one authenticated private partition.
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, MemoryRow, StoreError},
    recall::{acl, hash_embed::cosine_similarity, tombstone_mask::TombstoneMask},
    store::{RowFilter, Store},
};
use chrono::{Datelike, Days, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use std::collections::{HashMap, HashSet, VecDeque};

const MAX_NEIGHBOR_FETCH: usize = 4096;
const MIN_CLUSTER_SIZE: usize = 3;
const MAX_CLUSTER_SIZE: usize = 50;
const NEIGHBOR_THRESHOLD: f64 = 0.82;
const CENTROID_THRESHOLD: f64 = 0.74;

pub(crate) struct Week {
    pub key: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

pub(crate) fn previous_week(now: i64, zone: Tz) -> Result<Week, EngineError> {
    let local = chrono::DateTime::from_timestamp_millis(now)
        .ok_or(StoreError::InvalidInput)?
        .with_timezone(&zone)
        .date_naive();
    let days = u64::from(local.weekday().num_days_from_monday()) + 7;
    let monday = local
        .checked_sub_days(Days::new(days))
        .ok_or(StoreError::InvalidInput)?;
    let week = monday.iso_week();
    Ok(Week {
        key: format!("{:04}-W{:02}", week.year(), week.week()),
        start_ms: local_midnight(monday, zone)?,
        end_ms: local_midnight(
            monday
                .checked_add_days(Days::new(7))
                .ok_or(StoreError::InvalidInput)?,
            zone,
        )?,
    })
}

fn local_midnight(date: NaiveDate, zone: Tz) -> Result<i64, EngineError> {
    let midnight = date.and_hms_opt(0, 0, 0).ok_or(StoreError::InvalidInput)?;
    for minutes in 0..=180 {
        let value = midnight
            .checked_add_signed(chrono::Duration::minutes(minutes))
            .ok_or(StoreError::InvalidInput)?;
        if let Some(timestamp) = zone.from_local_datetime(&value).earliest() {
            return Ok(timestamp.with_timezone(&Utc).timestamp_millis());
        }
    }
    Err(StoreError::InvalidInput.into())
}

pub(crate) fn candidates(
    store: &Store,
    filter: &RowFilter,
    ctx: &RequestContext,
    tombstones: &TombstoneMask,
    week: &Week,
    limit: usize,
    cancel: &Cancel,
) -> Result<Vec<MemoryRow>, EngineError> {
    let mut accepted = Vec::new();
    let mut seen = HashSet::new();
    let budget = limit.saturating_mul(8);
    for offset in (0..budget).step_by(250) {
        cancel.check()?;
        let page = store.rem_candidates(
            filter,
            week.start_ms..week.end_ms,
            offset,
            250.min(budget - offset),
        )?;
        if page.is_empty() {
            break;
        }
        for row in page {
            cancel.check()?;
            if matches(&row, ctx) && !tombstones.masks(&row)? && seen.insert(row.id.clone()) {
                accepted.push(row);
                if accepted.len() == limit {
                    break;
                }
            }
        }
        if accepted.len() == limit {
            break;
        }
    }
    accepted.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(accepted)
}

fn matches(row: &MemoryRow, ctx: &RequestContext) -> bool {
    row.stored_by == ctx.agent_id.as_str()
        && row.workspace_key == ctx.workspace_key
        && row.owner_user_id == ctx.owner_user_id
        && row.scope == "agent-private"
        && acl::allowed(row, ctx).is_ok()
}

pub(crate) fn clusters(
    store: &Store,
    filter: &RowFilter,
    ctx: &RequestContext,
    week: &Week,
    rows: &[MemoryRow],
    top_k: usize,
    cancel: &Cancel,
) -> Result<Vec<Vec<usize>>, EngineError> {
    let by_id: HashMap<_, _> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| (row.id.as_str(), index))
        .collect();
    let wanted = top_k.min(rows.len().saturating_sub(1));
    let mut graph = vec![vec![]; rows.len()];
    for (index, memory) in rows.iter().enumerate() {
        cancel.check()?;
        if wanted == 0 || memory.vector.iter().all(|value| *value == 0.) {
            continue;
        }
        let mut limit = top_k.saturating_add(1).min(MAX_NEIGHBOR_FETCH);
        let neighbors = loop {
            let results =
                store.rem_neighbors(filter, week.start_ms..week.end_ms, &memory.vector, limit)?;
            let good: Vec<_> = results
                .iter()
                .filter_map(|result| {
                    let other = &result.row;
                    let idx = *by_id.get(other.id.as_str())?;
                    (idx != index && matches(other, ctx)).then_some(idx)
                })
                .take(wanted)
                .collect();
            if good.len() == wanted || results.len() < limit || limit == MAX_NEIGHBOR_FETCH {
                break good;
            }
            cancel.check()?;
            limit = (limit * 4).min(MAX_NEIGHBOR_FETCH);
        };
        for neighbor in neighbors {
            if cosine_similarity(&memory.vector, &rows[neighbor].vector) >= NEIGHBOR_THRESHOLD {
                graph[index].push(neighbor);
                graph[neighbor].push(index);
            }
        }
    }
    let components = components(&graph);
    Ok(components
        .into_iter()
        .flat_map(|members| validate(members, rows))
        .collect())
}

fn components(graph: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let mut visited = vec![false; graph.len()];
    let mut result = Vec::new();
    for (index, neighbors) in graph.iter().enumerate() {
        if neighbors.is_empty() || visited[index] {
            continue;
        }
        let mut component = Vec::new();
        let mut queue = VecDeque::from([index]);
        visited[index] = true;
        while let Some(current) = queue.pop_front() {
            component.push(current);
            for &neighbor in &graph[current] {
                if !visited[neighbor] {
                    visited[neighbor] = true;
                    queue.push_back(neighbor);
                }
            }
        }
        result.push(component);
    }
    result
}

fn validate(mut members: Vec<usize>, rows: &[MemoryRow]) -> Vec<Vec<usize>> {
    if members.len() < MIN_CLUSTER_SIZE {
        return vec![];
    }
    if members.len() > MAX_CLUSTER_SIZE {
        let right = members.split_off(members.len() / 2);
        return vec![members, right];
    }
    let mut centroid = vec![0.; rows[members[0]].vector.len()];
    for &member in &members {
        for (value, &part) in centroid.iter_mut().zip(&rows[member].vector) {
            *value += f64::from(part);
        }
    }
    let norm = centroid
        .iter()
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt();
    if norm == 0. {
        return vec![];
    }
    members.retain(|&member| {
        let (dot, length) = rows[member].vector.iter().zip(&centroid).fold(
            (0., 0.),
            |(dot, len), (&value, &mean)| {
                let value = f64::from(value);
                (dot + value * mean, len + value * value)
            },
        );
        dot / (length.sqrt() * norm) >= CENTROID_THRESHOLD
    });
    (members.len() >= MIN_CLUSTER_SIZE)
        .then_some(members)
        .into_iter()
        .collect()
}

pub(crate) fn samples(members: &[usize], rows: &[MemoryRow]) -> Vec<usize> {
    const LIMIT: usize = 20;
    if members.len() <= LIMIT {
        return members.to_vec();
    }
    let mut age = members.to_vec();
    age.sort_by_key(|&idx| rows[idx].created_at.as_i64().unwrap_or(0));
    let mut emotion = members.to_vec();
    emotion.sort_by(|&a, &b| intensity(&rows[b]).total_cmp(&intensity(&rows[a])));
    let mut seen = HashSet::new();
    age[..2]
        .iter()
        .chain(&age[age.len() - 2..])
        .chain(&emotion[..3])
        .chain(members)
        .copied()
        .filter(|index| seen.insert(*index))
        .take(LIMIT)
        .collect()
}

pub(crate) fn intensity(row: &MemoryRow) -> f64 {
    row.emotional_intensity.as_f64().unwrap_or(0.)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn previous_week_uses_iso_year_and_explicit_zone() {
        let now = chrono::DateTime::parse_from_rfc3339("2021-01-04T01:00:00Z")
            .unwrap()
            .timestamp_millis();
        let zurich = previous_week(now, chrono_tz::Europe::Zurich).unwrap();
        assert_eq!(zurich.key, "2020-W53");
        assert_eq!(zurich.start_ms, 1_609_110_000_000);
        let new_york = previous_week(now, chrono_tz::America::New_York).unwrap();
        assert_eq!(new_york.key, "2020-W52");
        assert_eq!(new_york.start_ms, 1_608_526_800_000);
    }
}
