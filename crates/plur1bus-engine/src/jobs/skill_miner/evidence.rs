//! Plugin-line evidence grouping for a single independently verified owner tuple.
use crate::{
    contract::{Cancel, EngineError, MemoryRow},
    text::js::{js_to_lower_case, locale_compare},
};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::OnceLock,
};

pub(super) struct Group {
    pub(super) rows: Vec<usize>,
    pub(super) score: usize,
}

pub(super) fn groups(rows: &[MemoryRow], cancel: &Cancel) -> Result<Vec<Group>, EngineError> {
    let profiles: Vec<_> = rows.iter().map(|row| keywords(&row.text)).collect();
    let terms: Vec<_> = rows.iter().map(|row| terms(&row.text)).collect();
    let mut postings: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (index, keywords) in profiles.iter().enumerate() {
        for keyword in keywords.keys() {
            postings.entry(keyword).or_default().push(index);
        }
    }
    let mut parents: Vec<_> = (0..rows.len()).collect();
    let mut shared = HashMap::<usize, (usize, usize)>::new();
    for (index, keywords) in profiles.iter().enumerate() {
        cancel.check()?;
        for (word, count) in keywords {
            let indexes = &postings[word.as_str()];
            let start = indexes.partition_point(|other| *other <= index);
            for &other in &indexes[start..] {
                let (multiplicity, distinct) = shared.entry(other).or_default();
                *multiplicity += count;
                *distinct += 1;
            }
        }
        for (other, (multiplicity, distinct)) in shared.drain() {
            let total = keywords.len() + profiles[other].len() - distinct;
            if (multiplicity as f64 / total as f64) >= 0.4 {
                let a = root(&mut parents, index);
                let b = root(&mut parents, other);
                parents[a] = b;
            }
        }
    }
    let mut ordinary: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (index, profile) in profiles.iter().enumerate() {
        if !profile.is_empty() {
            ordinary
                .entry(root(&mut parents, index))
                .or_default()
                .push(index);
        }
    }
    let mut ordinary: Vec<_> = ordinary.into_values().collect();
    ordinary.sort_by_key(|group| group[0]);
    let mut focused = BTreeMap::<&str, Vec<usize>>::new();
    for (index, words) in terms.iter().enumerate() {
        for word in words {
            focused.entry(word).or_default().push(index);
        }
    }
    let mut ranked = vec![];
    for (word, mut indexes) in focused {
        cancel.check()?;
        if !(2..=24.max(rows.len() * 15 / 100)).contains(&indexes.len()) {
            continue;
        }
        indexes.sort_by_key(|&index| std::cmp::Reverse(time(&rows[index])));
        indexes.truncate(24);
        let mut pairs = 0usize;
        let mut sum = 0.;
        for (position, &index) in indexes.iter().enumerate() {
            for &other in &indexes[position + 1..] {
                sum += overlap(&terms[index], &terms[other]);
                pairs += 1;
            }
        }
        let newest = time(&rows[indexes[0]]);
        let group = group(indexes, rows);
        ranked.push((word, group, newest, sum / pairs as f64));
    }
    let newest = ranked
        .iter()
        .map(|(_, _, time, _)| *time)
        .max()
        .unwrap_or(0);
    let priority = |group: &Group, time, coherence| {
        group.score as f64 * (0.05 + coherence) / (1. + (newest - time) as f64 / 604_800_000.)
    };
    ranked.sort_by(|a, b| {
        priority(&b.1, b.2, b.3)
            .total_cmp(&priority(&a.1, a.2, a.3))
            .then(b.2.cmp(&a.2))
            .then_with(|| locale_compare(a.0, b.0))
    });
    let mut selected = Vec::<(BTreeSet<usize>, Group)>::new();
    for (_, group, _, _) in ranked {
        let members: BTreeSet<_> = group.rows.iter().copied().collect();
        if selected
            .iter()
            .all(|(prior, _)| overlap(prior, &members) < 0.8)
        {
            selected.push((members, group));
            if selected.len() == 64 {
                break;
            }
        }
    }
    let mut seen = HashSet::new();
    Ok(selected
        .into_iter()
        .map(|(_, group)| group)
        .chain(ordinary.into_iter().map(|indexes| group(indexes, rows)))
        .filter(|group| {
            let mut key = group.rows.clone();
            key.sort_unstable();
            seen.insert(key)
        })
        .collect())
}

fn root(parents: &mut [usize], mut index: usize) -> usize {
    while parents[index] != index {
        let next = parents[index];
        parents[index] = parents[next];
        index = next;
    }
    index
}

fn keywords(text: &str) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for word in js_to_lower_case(text)
        .split(|ch: char| !ch.is_ascii_alphanumeric() && !matches!(ch, '_' | 'ä' | 'ö' | 'ü' | 'ß'))
    {
        if word.encode_utf16().count() >= 4 {
            *counts.entry(word.to_owned()).or_default() += 1;
        }
    }
    counts
}

const STOP: &str = concat!(
    "the and for with from that this these those have has had will would should could about into before after when then also user assistant message memory memories skill skills workflow ",
    "open", "claw plur1bus ",
    "und oder aber eine einer einen einem eines diese dieser dieses nicht wird werden wurde wurden haben hatte bitte sowie auch sich mehr nach fuer über durch kann können muss sollen immer dabei damit dazu sein sind waren meine deinem ihrer prüfen dokumentieren ",
    "dass habe genau alles deswegen nochmals weiterhin sondern unter noch bereits ebenfalls weitere weiteren aktuellen geändert bleibt bernd bernhardine heisenberg jetzt hier dort ohne sehr wirklich einfach eigentlich quasi natürlich vielleicht schon weil wenn dann machen gemacht gesagt möchten wollen wollte etwas sowohl sofern welche welcher welches diesen jenem meinem unserer ihnen deren deiner deines solche solcher hierbei soweit nochmal kannst weiß nächste",
);

pub(super) fn terms(text: &str) -> BTreeSet<String> {
    static EXPRESSIONS: OnceLock<Option<(regex::Regex, regex::Regex, regex::Regex)>> =
        OnceLock::new();
    let expressions = EXPRESSIONS.get_or_init(|| Some((
        regex::Regex::new(r"(?is)<file\b[^>]*>(.*?)</file>").ok()?,
        regex::Regex::new(r"(?i)<[^>]+>|\[Audio transcript[^\]]*\]:?|\[media attached:[^\]]*\]|https?://\S+|/(?:root|tmp)/\S+").ok()?,
        regex::Regex::new(r"\p{L}{4,}").ok()?,
    )));
    let Some((attachments, wrappers, words)) = expressions else {
        return BTreeSet::new();
    };
    let file = attachments.replace_all(text, |capture: &regex::Captures<'_>| {
        let value = capture.get(1).map_or("", |value| value.as_str());
        let lower = value.to_ascii_lowercase();
        if lower.contains("[unsupported document format")
            || lower.contains("[attachment could not be read")
        {
            " ".into()
        } else {
            value.to_owned()
        }
    });
    let stripped = wrappers.replace_all(&file, " ");
    let normalized = crate::text::js::nfkc(&stripped);
    let lower = js_to_lower_case(&normalized);
    let stop: HashSet<_> = STOP.split_whitespace().collect();
    words
        .find_iter(&lower)
        .map(|m| m.as_str())
        .filter(|word| !stop.contains(word))
        .map(str::to_owned)
        .collect()
}

pub(super) fn overlap<T: Ord>(a: &BTreeSet<T>, b: &BTreeSet<T>) -> f64 {
    let shared = a.intersection(b).count();
    let total = a.len() + b.len() - shared;
    if total == 0 {
        0.
    } else {
        shared as f64 / total as f64
    }
}

pub(super) fn time(row: &MemoryRow) -> i64 {
    row.created_at.as_f64().unwrap_or(0.) as i64
}

fn group(indexes: Vec<usize>, rows: &[MemoryRow]) -> Group {
    let score = indexes
        .iter()
        .map(|&i| {
            let row = &rows[i];
            1 + 2 * usize::from(matches!(
                row.epistemic_status.as_str(),
                "corroborated" | "trusted"
            )) + usize::from(matches!(
                row.category.as_str(),
                "workspace_rule" | "user_preference"
            )) + usize::from(
                row.retrieval_count
                    .as_f64()
                    .is_some_and(|value| value >= 3.),
            )
        })
        .sum();
    Group {
        rows: indexes,
        score,
    }
}
