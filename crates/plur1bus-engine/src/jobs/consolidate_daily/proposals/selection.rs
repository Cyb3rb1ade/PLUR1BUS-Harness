//! Deterministic proposals within one proved owner partition.
use crate::{
    contract::{Cancel, EngineError, MemoryRow},
    recall::score::normalize_epistemic_status,
    text::js::js_trim,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const BATCH: usize = 50;
const SIMILARITY: f64 = 0.88;

pub(super) fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn normalized(row: &MemoryRow) -> String {
    js_trim(&row.text).to_lowercase()
}

fn binding_key(row: &MemoryRow) -> (&str, &str, &str, &str) {
    (
        &row.scope,
        &row.agent_id,
        &row.workspace_key,
        &row.owner_user_id,
    )
}

pub(super) fn bindings(row: &MemoryRow) -> Value {
    json!({
        "scope":row.scope,"agentId":row.agent_id,
        "workspaceIdentity":row.workspace_key,"ownerUserId":row.owner_user_id
    })
}

pub(super) fn snapshot(row: &MemoryRow) -> Value {
    json!({
        "id":row.id,"textHash":hash(&row.text),"status":row.status,
        "epistemicStatus":normalize_epistemic_status(&row.epistemic_status),
        "epistemicStatusActor":row.epistemic_status_actor,
        "epistemicStatusReason":row.epistemic_status_reason,
        "previousEpistemicStatus":row.previous_epistemic_status,
        "epistemicStatusUpdatedAt":row.epistemic_status_updated_at,
        "validFrom":row.valid_from,"validUntil":row.valid_until,"aclBindings":bindings(row)
    })
}

fn disjoint(left: &MemoryRow, right: &MemoryRow) -> bool {
    let bound = |n: &serde_json::Number| n.as_f64().filter(|n| *n > 0.0);
    let different = |end, start| matches!((end,start), (Some(end),Some(start)) if end <= start);
    different(bound(&left.valid_until), bound(&right.valid_from))
        || different(bound(&right.valid_until), bound(&left.valid_from))
}

fn same_evidence(a: &MemoryRow, b: &MemoryRow) -> bool {
    a.epistemic_status == b.epistemic_status
        && a.epistemic_status_actor == b.epistemic_status_actor
        && a.epistemic_status_reason == b.epistemic_status_reason
        && a.previous_epistemic_status == b.previous_epistemic_status
        && a.epistemic_status_updated_at == b.epistemic_status_updated_at
}

fn action(keep: &MemoryRow, other: &MemoryRow, left: &str, right: &str) -> Value {
    let compatible = left.contains(right) || right.contains(left);
    let disjoint = disjoint(keep, other);
    let (kind, reason) = if left == right && !disjoint && same_evidence(keep, other) {
        ("delete", "identical_duplicate")
    } else if compatible {
        (
            "mark_redundant",
            if disjoint {
                "compatible_text_disjoint_validity_window"
            } else {
                "compatible_but_not_merged"
            },
        )
    } else {
        ("mark_conflict", "contradictory_content")
    };
    let mut value = json!({"type":kind,"id":other.id,"targetId":keep.id,"reason":reason,
        "aclBindings":bindings(keep),"expectedRows":[snapshot(other),snapshot(keep)]});
    if kind == "delete" {
        value["similarity"] = json!(1);
    }
    value
}

fn root(parents: &mut [usize], mut node: usize) -> usize {
    while node != parents[node] {
        parents[node] = parents[parents[node]];
        node = parents[node];
    }
    node
}

pub(super) fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (dot, aa, bb) = a
        .iter()
        .zip(b)
        .fold((0.0, 0.0, 0.0), |(dot, aa, bb), (&a, &b)| {
            let (a, b) = (f64::from(a), f64::from(b));
            (dot + a * b, aa + a * a, bb + b * b)
        });
    if aa > 0.0 && bb > 0.0 {
        dot / (aa * bb).sqrt()
    } else {
        0.0
    }
}

pub(super) fn actions(
    rows: &[MemoryRow],
    verified_vectors: bool,
    cancel: &Cancel,
) -> Result<Vec<Value>, EngineError> {
    let mut ordered: Vec<_> = rows.iter().collect();
    ordered.sort_by(|a, b| {
        b.created_at
            .as_f64()
            .unwrap_or_default()
            .total_cmp(&a.created_at.as_f64().unwrap_or_default())
            .then(a.id.cmp(&b.id))
    });
    let texts: Vec<_> = ordered.iter().map(|row| normalized(row)).collect();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut first = HashMap::new();
    for (index, (row, text)) in ordered.iter().zip(&texts).enumerate() {
        cancel.check()?;
        let key = (binding_key(row), text.as_str());
        let group = *first.entry(key).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[group].push(index);
    }
    let mut exact = vec![false; ordered.len()];
    let mut result = Vec::new();
    let build = |group: &[usize], result: &mut Vec<Value>| {
        if let Some((&keep, rest)) = group.split_first() {
            for &other in rest {
                result.push(action(
                    ordered[keep],
                    ordered[other],
                    &texts[keep],
                    &texts[other],
                ));
            }
        }
    };
    for group in groups.iter().filter(|group| group.len() > 1) {
        for &index in group {
            exact[index] = true;
        }
        build(group, &mut result);
    }
    if verified_vectors {
        for start in (0..ordered.len()).step_by(BATCH) {
            cancel.check()?;
            let batch: Vec<_> = (start..(start + BATCH).min(ordered.len()))
                .filter(|&i| !exact[i])
                .collect();
            let mut parents: Vec<_> = (0..batch.len()).collect();
            for (i, &a) in batch.iter().enumerate() {
                for (j, &b) in batch.iter().enumerate().skip(i + 1) {
                    if binding_key(ordered[a]) == binding_key(ordered[b])
                        && cosine(&ordered[a].vector, &ordered[b].vector) >= SIMILARITY
                    {
                        let (x, y) = (root(&mut parents, i), root(&mut parents, j));
                        parents[y] = x;
                    }
                }
            }
            let mut clusters = vec![Vec::new(); batch.len()];
            for (i, index) in batch.into_iter().enumerate() {
                clusters[root(&mut parents, i)].push(index);
            }
            let mut clusters: Vec<_> = clusters.into_iter().filter(|c| c.len() > 1).collect();
            clusters.sort_by_key(|c| c[0]);
            for cluster in &clusters {
                build(cluster, &mut result);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "synthetic fixture setup and custody assertions"
)]
mod tests {
    use super::*;
    use crate::capture::row_defaults::schema_defaults;

    #[test]
    fn exact_groups_cross_batches_and_preserve_temporal_and_owner_partitions() {
        let mut rows: Vec<_> = (0..=51)
            .map(|i| {
                let mut row = schema_defaults(vec![i as f32, 1.0]);
                row.id = uuid::Uuid::from_u128(i as u128 + 1).to_string();
                row.created_at = i.into();
                row.scope = "agent-private".into();
                row.text = format!("synthetic {i}");
                row
            })
            .collect();
        rows[0].text = "Equivalent text".into();
        rows[51].text = "  EQUIVALENT TEXT  ".into();
        let mut other = rows[51].clone();
        other.id = uuid::Uuid::from_u128(60).to_string();
        other.scope = "workspace".into();
        rows.push(other);
        let approved = actions(&rows, false, &Cancel::never()).unwrap();
        assert_eq!(approved.len(), 1);
        assert_eq!(approved[0]["type"], "delete");
        assert_eq!(approved[0]["id"], rows[0].id);
        rows[0].valid_until = 50.into();
        rows[51].valid_from = 50.into();
        let approved = actions(&rows, false, &Cancel::never()).unwrap();
        assert_eq!(
            approved[0]["reason"],
            "compatible_text_disjoint_validity_window"
        );
    }

    #[test]
    fn similarity_needs_a_verified_space_and_recommends_review() {
        let mut a = schema_defaults(vec![1., 0.]);
        a.scope = "agent-private".into();
        a.id = "a".into();
        a.text = "The team works until nine".into();
        let mut b = a.clone();
        b.id = "b".into();
        b.text = "The team works until ten".into();
        let rows = [a, b];
        assert!(actions(&rows, false, &Cancel::never()).unwrap().is_empty());
        let result = actions(&rows, true, &Cancel::never()).unwrap();
        assert_eq!(result[0]["type"], "mark_conflict");
        assert_eq!(result[0]["id"], "b");
    }

    #[test]
    fn vector_actions_respect_the_similarity_threshold_and_batch_boundary() {
        let direction = |cosine: f32| vec![cosine, (1.0 - cosine * cosine).sqrt()];
        let mut rows: Vec<_> = (0..=50)
            .map(|i| {
                let mut row = schema_defaults(vec![0.0, 0.0]);
                row.scope = "agent-private".into();
                row.id = format!("synthetic-{i}");
                row.created_at = i.into();
                row.text = format!("Synthetic observation {i}");
                row
            })
            .collect();
        rows[0].vector = vec![1.0, 0.0];
        rows[1].vector = direction(0.879);
        let cancel = Cancel::never();
        assert!(actions(&rows[..2], true, &cancel).unwrap().is_empty());
        rows[1].vector = direction(0.881);
        assert_eq!(actions(&rows[..2], true, &cancel).unwrap().len(), 1);

        // The same pair is split across two 50-row batches after ordering.
        assert!(actions(&rows, true, &cancel).unwrap().is_empty());
    }

    #[test]
    fn matching_text_with_different_evidence_stays_a_review_proposal() {
        let mut older = schema_defaults(vec![1.0]);
        older.id = "older".into();
        older.text = "Synthetic observation".into();
        let mut newer = older.clone();
        newer.id = "newer".into();
        newer.created_at = 1.into();
        newer.epistemic_status_reason = "independent verification".into();

        let proposals = actions(&[older, newer], false, &Cancel::never()).unwrap();
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0]["type"], "mark_redundant");
        assert_eq!(proposals[0]["reason"], "compatible_but_not_merged");
        assert_eq!(proposals[0]["id"], "older");
        assert_eq!(proposals[0]["targetId"], "newer");
    }
}
