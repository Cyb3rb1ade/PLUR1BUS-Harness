//! `collab/board.ts`: the project board (columns, cards, comments, activity) as one JSON document per project in
//! `project_boards.data`, on the collab store's connection. Every mutation, including its history, is one `BEGIN IMMEDIATE`
//! transaction; the whole document is rewritten (`JSON.stringify` of what `JSON.parse` read), so the bytes a Rust writer
//! leaves are the bytes a TypeScript writer would leave: members in the order they were first written, extra members a card
//! or an actor carries kept, a no-op `assign` still rewriting the text.
//!
//! The document is held as [`J`] (parsed JSON with member order) and edited member by member, which is what the TypeScript
//! code does to its objects. Actors, assignees and links are objects a caller passes (the tool layer validates them); the
//! store copies them whole (`{...actor}`) and compares only `kind` and `id`.
//!
//! **JavaScript details this code reproduces:** `title` checks `length <= 256` on the untrimmed text in UTF-16 units;
//! a position, a limit or a WIP limit is accepted only as a safe integer (`Number.isSafeInteger`); sorting by id uses
//! `localeCompare` (ICU root order, [`crate::metrics::registry::locale_compare`]) where cards are ordered and the UTF-16 code
//! unit order where the keyset page is ordered by id; a cursor is `base64url` that Node decodes leniently, bound to the
//! query by a SHA-256 over `JSON.stringify` of its arguments (an absent argument prints as `null`); a card link of kind `url`
//! must be `http(s):` or `mailto:` written exactly, with no white space or control character, and must parse as a URL.
use super::errors::CollabError;
use super::limits::CollaborationLimitsConfig;
use super::store::{live_in, project_in, CollabStore, R};
use crate::approvals::js_json::J;
use crate::js::{compare_utf16, is_js_space, js_trim, to_lower_case, utf16_len};
use crate::metrics::registry::locale_compare;
use base64::Engine;
use plur1bus_store::rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

const PRIORITIES: [&str; 5] = ["none", "low", "normal", "high", "urgent"];
const LINK_KINDS: [&str; 4] = ["session", "job", "media", "url"];

fn bad<T>(message: &str) -> R<T> {
    Err(CollabError::board("invalid", message))
}
fn board_err<T>(code: &'static str, message: &str) -> R<T> {
    Err(CollabError::board(code, message))
}

/// `Number.isSafeInteger`.
fn safe_int(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

/// The document: four arrays, in the order `data` stores them.
struct Data {
    columns: Vec<J>,
    cards: Vec<J>,
    activity: Vec<J>,
    comments: Vec<J>,
}

fn gs<'a>(j: &'a J, k: &str) -> &'a str {
    j.get(k).and_then(J::as_str).unwrap_or("")
}
fn gn(j: &J, k: &str) -> f64 {
    j.get(k).and_then(J::as_f64).unwrap_or(f64::NAN)
}
fn arr<'a>(j: &'a J, k: &str) -> &'a [J] {
    match j.get(k) {
        Some(J::Arr(a)) => a,
        _ => &[],
    }
}
fn num(n: usize) -> J {
    J::Num(n as f64)
}

/// `same(a, b)`: kind and id only.
fn same(a: &J, b: &J) -> bool {
    a.get("kind") == b.get("kind") && a.get("id") == b.get("id")
}

/// `title(s)`: `s.trim().length > 0 && s.length <= 256 ? s.trim() : bad`.
fn title(s: &str) -> R<String> {
    let t = js_trim(s);
    if !t.is_empty() && utf16_len(s) <= 256 {
        Ok(t.to_owned())
    } else {
        bad("invalid title")
    }
}

/// `index(n, size)`.
fn index(n: Option<f64>, size: usize) -> R<usize> {
    match n {
        None => Ok(size),
        Some(v) if safe_int(v) && v >= 0.0 => Ok(if v < size as f64 { v as usize } else { size }),
        Some(_) => bad("invalid position"),
    }
}

/// `limit(n = 50)`.
fn limit(n: Option<f64>) -> R<usize> {
    match n {
        None => Ok(50),
        Some(v) if safe_int(v) && v > 0.0 && v <= 100.0 => Ok(v as usize),
        Some(_) => bad("invalid limit"),
    }
}

/// `safeLinkUrl`: `/^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f\u007f]+$/i` and `URL.canParse`.
fn safe_link_url(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    let prefix = ["https://", "http://", "mailto:"]
        .into_iter()
        .find(|p| lower.starts_with(p));
    let Some(prefix) = prefix else {
        return false;
    };
    // The prefixes are ASCII, so their byte length is the character count.
    let rest = &s[prefix.len()..];
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| !is_js_space(c) && !matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'))
        && url::Url::parse(s).is_ok()
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Node's lenient `Buffer.from(text, "base64url")`: both alphabets, characters outside them skipped, `=` ends the input,
/// leftover bits dropped.
fn node_base64url(text: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for ch in text.chars() {
        let v = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((acc >> bits) & 0xff) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    bytes
}

/// A page of something with an `id`.
pub struct Page {
    /// The items of this page.
    pub items: Vec<J>,
    /// The cursor of the next page.
    pub next_cursor: Option<String>,
}

/// `page(items, input, binding, ordered)`.
fn page(
    items: Vec<J>,
    cursor: Option<&str>,
    take: Option<f64>,
    binding: &J,
    ordered: bool,
) -> R<Page> {
    let take = limit(take)?;
    let hash = sha256_hex(&binding.stringify());
    let mut after = String::new();
    if let Some(cursor) = cursor.filter(|c| !c.is_empty()) {
        let decoded = String::from_utf8_lossy(&node_base64url(cursor)).into_owned();
        let parsed = J::parse(&decoded);
        let (h, a) = match &parsed {
            Some(c) => (c.get("hash"), c.get("after")),
            None => return bad("invalid cursor"),
        };
        let ok = h == Some(&J::Str(hash.clone()))
            && matches!(a, Some(J::Str(_)))
            && utf16_len(cursor) <= 2048;
        if !ok {
            return bad("invalid cursor");
        }
        after = a.and_then(J::as_str).unwrap_or("").to_owned();
        if ordered && !items.iter().any(|i| gs(i, "id") == after) {
            return bad("invalid cursor");
        }
    }
    let remaining: Vec<J> = if ordered {
        let start = if after.is_empty() {
            0
        } else {
            items
                .iter()
                .position(|i| gs(i, "id") == after)
                .map_or(0, |p| p + 1)
        };
        items[start..].to_vec()
    } else {
        let mut r: Vec<J> = items
            .into_iter()
            .filter(|i| compare_utf16(gs(i, "id"), &after) == Ordering::Greater)
            .collect();
        r.sort_by(|a, b| compare_utf16(gs(a, "id"), gs(b, "id")));
        r
    };
    let selected: Vec<J> = remaining.iter().take(take).cloned().collect();
    let next_cursor = if remaining.len() > take {
        let last = selected.last().map_or("", |i| gs(i, "id"));
        let text = J::obj([("hash", J::s(&hash)), ("after", J::s(last))]).stringify();
        Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text))
    } else {
        None
    };
    Ok(Page {
        items: selected,
        next_cursor,
    })
}

/// `CardInput` and the patch of `updateCard` (a field left `None` is not touched).
#[derive(Clone, Debug, Default)]
pub struct CardFields {
    /// `title`
    pub title: Option<String>,
    /// `description`
    pub description: Option<String>,
    /// `labels`
    pub labels: Option<Vec<String>>,
    /// `priority`
    pub priority: Option<String>,
    /// `dueAt`: `Some(None)` clears it.
    pub due_at: Option<Option<f64>>,
    /// `links`: objects with `kind` and `id` (and whatever else the caller sent).
    pub links: Option<Vec<J>>,
}

/// `CardFilter`.
#[derive(Clone, Debug, Default)]
pub struct CardFilter {
    /// `columnId`
    pub column_id: Option<String>,
    /// `assignee`: the object as the caller wrote it (its member order is part of the cursor binding).
    pub assignee: Option<J>,
    /// `label`
    pub label: Option<String>,
    /// `text`
    pub text: Option<String>,
    /// `archived`
    pub archived: Option<bool>,
    /// `cursor`
    pub cursor: Option<String>,
    /// `limit`
    pub limit: Option<f64>,
}

fn column_idx(d: &Data, id: &str) -> R<usize> {
    d.columns
        .iter()
        .position(|c| gs(c, "id") == id)
        .map_or_else(|| board_err("not-found", "column not found"), Ok)
}

fn card_idx(d: &Data, id: &str) -> R<usize> {
    d.cards
        .iter()
        .position(|c| gs(c, "id") == id)
        .map_or_else(|| board_err("not-found", "card not found"), Ok)
}

fn renumber(list: &mut [J]) {
    for (i, x) in list.iter_mut().enumerate() {
        x.set("position", num(i));
    }
}

fn valid_wip(n: Option<f64>) -> R<()> {
    match n {
        Some(v) if !safe_int(v) || v < 1.0 => bad("invalid WIP limit"),
        _ => Ok(()),
    }
}

fn opt_num(n: Option<f64>) -> J {
    n.map_or(J::Null, J::Num)
}

fn actor_copy(a: &J) -> J {
    a.clone()
}

impl CollabStore {
    fn read_board(
        &self,
        c: &Connection,
        config: &CollaborationLimitsConfig,
        project_id: &str,
    ) -> R<Data> {
        if project_in(c, config, project_id)?.is_none() {
            return board_err("not-found", "project not found");
        }
        let text: Option<String> = c
            .query_row(
                "SELECT data FROM project_boards WHERE project_id = ?",
                [project_id],
                |r| r.get(0),
            )
            .ok();
        let Some(text) = text else {
            return board_err("not-found", "board not found");
        };
        let Some(j) = J::parse(&text) else {
            return Err(CollabError::raw("board data does not parse"));
        };
        let take = |k: &str| arr(&j, k).to_vec();
        Ok(Data {
            columns: take("columns"),
            cards: take("cards"),
            activity: take("activity"),
            comments: take("comments"),
        })
    }

    fn save_board(&self, c: &Connection, project_id: &str, d: &Data) -> R<()> {
        let doc = J::obj([
            ("columns", J::Arr(d.columns.clone())),
            ("cards", J::Arr(d.cards.clone())),
            ("activity", J::Arr(d.activity.clone())),
            ("comments", J::Arr(d.comments.clone())),
        ]);
        c.execute(
            "UPDATE project_boards SET data = ? WHERE project_id = ?",
            plur1bus_store::rusqlite::params![doc.stringify(), project_id],
        )?;
        Ok(())
    }

    /// `#write`: one `BEGIN IMMEDIATE` transaction around read, check, change and write.
    fn write_board<T>(
        &self,
        project_id: &str,
        f: impl FnOnce(&Connection, &mut Data) -> R<T>,
    ) -> R<T> {
        let config = self.config();
        self.tx(|c| {
            let mut d = self.read_board(c, &config, project_id)?;
            let archived =
                project_in(c, &config, project_id)?.is_some_and(|p| p.archived_at.is_some());
            if archived {
                return board_err("archived", "project archived");
            }
            let out = f(c, &mut d)?;
            self.save_board(c, project_id, &d)?;
            Ok(out)
        })
    }

    fn read_only(&self, project_id: &str) -> R<Data> {
        self.read_board(self.conn()?, &self.config(), project_id)
    }

    fn wip(&self, d: &Data, column_id: &str, incoming: usize, over: bool) -> R<()> {
        let c = &d.columns[column_idx(d, column_id)?];
        let wip = c.get("wipLimit").and_then(J::as_f64);
        if incoming > 0 && !over {
            if let Some(limit) = wip {
                let n = d
                    .cards
                    .iter()
                    .filter(|x| {
                        gs(x, "columnId") == column_id && x.get("archived") != Some(&J::Bool(true))
                    })
                    .count();
                if (n + incoming) as f64 > limit {
                    return board_err("wip", "project WIP limit exceeded");
                }
            }
        }
        Ok(())
    }

    fn history(&self, d: &mut Data, ci: usize, kind: &str, actor: &J, detail: &str) {
        let at = self.clock.now();
        let card = &mut d.cards[ci];
        card.set("updatedAt", J::Num(at as f64));
        card.set("updatedBy", actor_copy(actor));
        let id = format!("{:0>16}", d.activity.len() + 1);
        let card_id = gs(&d.cards[ci], "id").to_owned();
        d.activity.push(J::obj([
            ("id", J::Str(id)),
            ("cardId", J::Str(card_id)),
            ("kind", J::s(kind)),
            ("actor", actor_copy(actor)),
            ("at", J::Num(at as f64)),
            ("detail", J::s(detail)),
        ]));
    }

    fn place(&self, d: &mut Data, ci: usize, column_id: &str, position: Option<f64>) -> R<()> {
        column_idx(d, column_id)?;
        let old = gs(&d.cards[ci], "columnId").to_owned();
        let mut target: Vec<usize> = (0..d.cards.len())
            .filter(|&i| i != ci && gs(&d.cards[i], "columnId") == column_id)
            .collect();
        target.sort_by(|&a, &b| {
            gn(&d.cards[a], "position")
                .partial_cmp(&gn(&d.cards[b], "position"))
                .unwrap_or(Ordering::Equal)
                .then_with(|| locale_compare(gs(&d.cards[a], "id"), gs(&d.cards[b], "id")))
        });
        let at = index(position, target.len())?;
        target.insert(at, ci);
        d.cards[ci].set("columnId", J::s(column_id));
        for (i, &x) in target.iter().enumerate() {
            d.cards[x].set("position", num(i));
        }
        if old != column_id {
            let mut rest: Vec<usize> = (0..d.cards.len())
                .filter(|&i| gs(&d.cards[i], "columnId") == old)
                .collect();
            rest.sort_by(|&a, &b| {
                gn(&d.cards[a], "position")
                    .partial_cmp(&gn(&d.cards[b], "position"))
                    .unwrap_or(Ordering::Equal)
            });
            for (i, &x) in rest.iter().enumerate() {
                d.cards[x].set("position", num(i));
            }
        }
        Ok(())
    }

    /// Runs inside the caller's transaction (member or agent removal): an assignment must not outlive the membership it
    /// required.
    pub(crate) fn release_assignee_in(
        &self,
        c: &Connection,
        config: &CollaborationLimitsConfig,
        project_id: &str,
        kind: &str,
        id: &str,
    ) -> R<()> {
        let mut d = self.read_board(c, config, project_id)?;
        let owner = project_in(c, config, project_id)?
            .map(|p| p.owner)
            .unwrap_or_default();
        let assignee = J::obj([("kind", J::s(kind)), ("id", J::s(id))]);
        let mut changed = false;
        for ci in 0..d.cards.len() {
            if !arr(&d.cards[ci], "assignees")
                .iter()
                .any(|a| same(a, &assignee))
            {
                continue;
            }
            let kept: Vec<J> = arr(&d.cards[ci], "assignees")
                .iter()
                .filter(|a| !same(a, &assignee))
                .cloned()
                .collect();
            d.cards[ci].set("assignees", J::Arr(kept));
            changed = true;
            let mut detail = assignee.clone();
            detail.set("reason", J::s("membership-removed"));
            self.history(
                &mut d,
                ci,
                "unassigned",
                &J::obj([("kind", J::s("person")), ("id", J::Str(owner.clone()))]),
                &detail.stringify(),
            );
        }
        if changed {
            self.save_board(c, project_id, &d)?;
        }
        Ok(())
    }

    /// `columns(projectId)`: by position.
    pub fn board_columns(&self, project_id: &str) -> R<Vec<J>> {
        let mut cols = self.read_only(project_id)?.columns;
        cols.sort_by(|a, b| {
            gn(a, "position")
                .partial_cmp(&gn(b, "position"))
                .unwrap_or(Ordering::Equal)
        });
        Ok(cols)
    }

    /// `createColumn`.
    pub fn board_create_column(
        &self,
        project_id: &str,
        title_text: Option<&str>,
        title_key: Option<&str>,
        wip_limit: Option<f64>,
        position: Option<f64>,
    ) -> R<J> {
        self.write_board(project_id, |_, d| {
            if title_text.is_none_or(str::is_empty) && title_key.is_none_or(str::is_empty) {
                return bad("title or titleKey required");
            }
            let id = self.id("col");
            let t = match title_text.filter(|s| !s.is_empty()) {
                Some(s) => J::Str(title(s)?),
                None => J::Null,
            };
            let k = match title_key.filter(|s| !s.is_empty()) {
                Some(s) => J::Str(title(s)?),
                None => J::Null,
            };
            valid_wip(wip_limit)?;
            let col = J::obj([
                ("id", J::Str(id)),
                ("title", t),
                ("titleKey", k),
                ("position", J::Num(0.0)),
                ("wipLimit", opt_num(wip_limit)),
            ]);
            let at = index(position, d.columns.len())?;
            d.columns.insert(at, col);
            renumber(&mut d.columns);
            Ok(d.columns[at].clone())
        })
    }

    /// `updateColumn`: `wip_limit` is `Some(None)` to clear.
    pub fn board_update_column(
        &self,
        project_id: &str,
        id: &str,
        title_text: Option<&str>,
        title_key: Option<&str>,
        wip_limit: Option<Option<f64>>,
    ) -> R<J> {
        self.write_board(project_id, |_, d| {
            let ci = column_idx(d, id)?;
            if let Some(t) = title_text {
                let v = title(t)?;
                d.columns[ci].set("title", J::Str(v));
                d.columns[ci].set("titleKey", J::Null);
            }
            if let Some(t) = title_key {
                let v = title(t)?;
                d.columns[ci].set("titleKey", J::Str(v));
                d.columns[ci].set("title", J::Null);
            }
            if let Some(w) = wip_limit {
                valid_wip(w)?;
                d.columns[ci].set("wipLimit", opt_num(w));
            }
            Ok(d.columns[ci].clone())
        })
    }

    /// `moveColumn`.
    pub fn board_move_column(&self, project_id: &str, id: &str, position: f64) -> R<J> {
        self.write_board(project_id, |_, d| {
            let ci = column_idx(d, id)?;
            let c = d.columns.remove(ci);
            let at = index(Some(position), d.columns.len())?;
            d.columns.insert(at, c);
            renumber(&mut d.columns);
            Ok(d.columns[at].clone())
        })
    }

    /// `deleteColumn`: a column with cards needs a target; the cards move there in position order.
    pub fn board_delete_column(
        &self,
        project_id: &str,
        id: &str,
        target: Option<&str>,
        actor: &J,
        over: bool,
    ) -> R<()> {
        self.write_board(project_id, |_, d| {
            column_idx(d, id)?;
            if target == Some(id) {
                return bad("target must differ from deleted column");
            }
            let mut moving: Vec<usize> = (0..d.cards.len())
                .filter(|&i| gs(&d.cards[i], "columnId") == id)
                .collect();
            moving.sort_by(|&a, &b| {
                gn(&d.cards[a], "position")
                    .partial_cmp(&gn(&d.cards[b], "position"))
                    .unwrap_or(Ordering::Equal)
            });
            let target = target.filter(|t| !t.is_empty());
            if let Some(t) = target {
                let live = moving
                    .iter()
                    .filter(|&&i| d.cards[i].get("archived") != Some(&J::Bool(true)))
                    .count();
                self.wip(d, t, live, over)?;
            } else if !moving.is_empty() {
                return board_err("conflict", "column must be empty or have target column");
            }
            for ci in moving {
                let t = target.unwrap_or_default();
                self.place(d, ci, t, None)?;
                let detail = J::obj([
                    ("from", J::s(id)),
                    ("to", J::s(t)),
                    ("override", J::Bool(over)),
                ])
                .stringify();
                self.history(d, ci, "moved", actor, &detail);
            }
            d.columns.retain(|c| gs(c, "id") != id);
            renumber(&mut d.columns);
            Ok(())
        })
    }

    /// `getCard`.
    pub fn board_get_card(&self, project_id: &str, id: &str) -> R<J> {
        let d = self.read_only(project_id)?;
        let ci = card_idx(&d, id)?;
        Ok(d.cards[ci].clone())
    }

    /// `cards(projectId, filter)`: the live or archived cards in column and position order, keyset paged.
    pub fn board_cards(&self, project_id: &str, f: &CardFilter) -> R<(Vec<J>, Option<String>)> {
        let d = self.read_only(project_id)?;
        if let Some(col) = f.column_id.as_deref().filter(|s| !s.is_empty()) {
            column_idx(&d, col)?;
        }
        let wanted = f.archived.unwrap_or(false);
        let needle = f
            .text
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(to_lower_case);
        let mut items: Vec<J> = d
            .cards
            .iter()
            .filter(|c| {
                (c.get("archived") == Some(&J::Bool(true))) == wanted
                    && f.column_id
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .is_none_or(|col| gs(c, "columnId") == col)
                    && f.assignee
                        .as_ref()
                        .is_none_or(|a| arr(c, "assignees").iter().any(|x| same(x, a)))
                    && f.label
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .is_none_or(|l| arr(c, "labels").iter().any(|x| x.as_str() == Some(l)))
                    && needle.as_ref().is_none_or(|n| {
                        to_lower_case(&format!("{}\n{}", gs(c, "title"), gs(c, "description")))
                            .contains(n.as_str())
                    })
            })
            .cloned()
            .collect();
        let col_pos = |c: &J| -> f64 {
            d.columns
                .iter()
                .find(|x| gs(x, "id") == gs(c, "columnId"))
                .map_or(f64::NAN, |x| gn(x, "position"))
        };
        items.sort_by(|a, b| {
            col_pos(a)
                .partial_cmp(&col_pos(b))
                .unwrap_or(Ordering::Equal)
                .then_with(|| {
                    gn(a, "position")
                        .partial_cmp(&gn(b, "position"))
                        .unwrap_or(Ordering::Equal)
                })
                .then_with(|| locale_compare(gs(a, "id"), gs(b, "id")))
        });
        let opt = |v: &Option<String>| v.as_ref().map_or(J::Null, |s| J::Str(s.clone()));
        let binding = J::Arr(vec![
            J::s(project_id),
            opt(&f.column_id),
            f.assignee.clone().unwrap_or(J::Null),
            opt(&f.label),
            opt(&f.text),
            J::Bool(wanted),
            J::Arr(
                items
                    .iter()
                    .map(|c| {
                        J::Arr(vec![
                            c.get("id").cloned().unwrap_or(J::Null),
                            c.get("updatedAt").cloned().unwrap_or(J::Null),
                            c.get("columnId").cloned().unwrap_or(J::Null),
                            c.get("position").cloned().unwrap_or(J::Null),
                        ])
                    })
                    .collect(),
            ),
        ]);
        let p = page(items, f.cursor.as_deref(), f.limit, &binding, true)?;
        Ok((p.items, p.next_cursor))
    }

    fn apply_fields(&self, card: &mut J, p: &CardFields) -> R<()> {
        if let Some(t) = &p.title {
            card.set("title", J::Str(title(t)?));
        }
        if let Some(t) = &p.description {
            if utf16_len(t) > 65_536 {
                return bad("invalid description");
            }
            card.set("description", J::s(t));
        }
        if let Some(l) = &p.labels {
            if l.len() > 32 || l.iter().any(|s| s.is_empty() || utf16_len(s) > 64) {
                return bad("invalid labels");
            }
            let mut seen: Vec<&String> = Vec::new();
            for s in l {
                if !seen.contains(&s) {
                    seen.push(s);
                }
            }
            card.set(
                "labels",
                J::Arr(seen.into_iter().map(|s| J::s(s)).collect()),
            );
        }
        if let Some(pr) = &p.priority {
            if !PRIORITIES.contains(&pr.as_str()) {
                return bad("invalid priority");
            }
            card.set("priority", J::s(pr));
        }
        if let Some(due) = p.due_at {
            if let Some(v) = due {
                if !safe_int(v) || v < 0.0 {
                    return bad("invalid dueAt");
                }
            }
            card.set("dueAt", opt_num(due));
        }
        if let Some(links) = &p.links {
            let invalid = links.len() > 64
                || links.iter().any(|l| {
                    let kind = l.get("kind").and_then(J::as_str);
                    let id = l.get("id").and_then(J::as_str);
                    !kind.is_some_and(|k| LINK_KINDS.contains(&k))
                        || id.is_none_or(|i| {
                            i.is_empty()
                                || utf16_len(i) > 4096
                                || (kind == Some("url") && !safe_link_url(i))
                        })
                });
            if invalid {
                return bad("invalid links");
            }
            card.set("links", J::Arr(links.clone()));
        }
        Ok(())
    }

    /// `createCard`: the card gets the next position in its column unless one is given.
    pub fn board_create_card(
        &self,
        project_id: &str,
        column_id: &str,
        position: Option<f64>,
        input: &CardFields,
        actor: &J,
        over: bool,
    ) -> R<J> {
        self.write_board(project_id, |_, d| {
            self.wip(d, column_id, 1, over)?;
            let now = self.clock.now() as f64;
            let id = self.id("card");
            let t = title(input.title.as_deref().unwrap_or(""))?;
            let mut card = J::obj([
                ("id", J::Str(id)),
                ("projectId", J::s(project_id)),
                ("title", J::Str(t)),
                ("description", J::s("")),
                ("columnId", J::s(column_id)),
                ("position", J::Num(0.0)),
                ("labels", J::Arr(vec![])),
                ("priority", J::s("normal")),
                ("dueAt", J::Null),
                ("assignees", J::Arr(vec![])),
                ("links", J::Arr(vec![])),
                ("createdBy", actor_copy(actor)),
                ("updatedBy", actor_copy(actor)),
                ("createdAt", J::Num(now)),
                ("updatedAt", J::Num(now)),
                ("archived", J::Bool(false)),
            ]);
            self.apply_fields(&mut card, input)?;
            d.cards.push(card);
            let ci = d.cards.len() - 1;
            self.place(d, ci, column_id, position)?;
            let detail = J::obj([("override", J::Bool(over))]).stringify();
            self.history(d, ci, "created", actor, &detail);
            Ok(d.cards[ci].clone())
        })
    }

    /// `updateCard`.
    pub fn board_update_card(
        &self,
        project_id: &str,
        id: &str,
        patch: &CardFields,
        actor: &J,
    ) -> R<J> {
        self.write_board(project_id, |_, d| {
            let ci = card_idx(d, id)?;
            let mut card = d.cards[ci].clone();
            let outcome = self.apply_fields(&mut card, patch);
            // TypeScript mutates the card as it validates, so a refusal midway leaves the earlier fields set in memory; the
            // transaction rolls it back, so nothing of it is stored.
            outcome?;
            d.cards[ci] = card;
            self.history(d, ci, "updated", actor, "");
            Ok(d.cards[ci].clone())
        })
    }

    /// `moveCard`.
    pub fn board_move_card(
        &self,
        project_id: &str,
        id: &str,
        column_id: &str,
        position: Option<f64>,
        actor: &J,
        over: bool,
    ) -> R<J> {
        self.write_board(project_id, |_, d| {
            let ci = card_idx(d, id)?;
            if d.cards[ci].get("archived") == Some(&J::Bool(true)) {
                return board_err("archived", "card archived");
            }
            let from = gs(&d.cards[ci], "columnId").to_owned();
            if from != column_id {
                self.wip(d, column_id, 1, over)?;
            }
            self.place(d, ci, column_id, position)?;
            let detail = J::obj([
                ("from", J::Str(from)),
                ("to", J::s(column_id)),
                (
                    "position",
                    d.cards[ci].get("position").cloned().unwrap_or(J::Null),
                ),
                ("override", J::Bool(over)),
            ])
            .stringify();
            self.history(d, ci, "moved", actor, &detail);
            Ok(d.cards[ci].clone())
        })
    }

    /// `assign`: adding needs the assignee to belong to the project; a no-op still rewrites the document.
    pub fn board_assign(
        &self,
        project_id: &str,
        id: &str,
        assignee: &J,
        add: bool,
        actor: &J,
    ) -> R<J> {
        let config = self.config();
        self.write_board(project_id, |c, d| {
            let p = project_in(c, &config, project_id)?
                .ok_or_else(|| CollabError::raw("project vanished"))?;
            if add {
                let who = assignee.get("id").and_then(J::as_str);
                let belongs = if assignee.get("kind").and_then(J::as_str) == Some("person") {
                    p.members.iter().any(|m| Some(m.user_id.as_str()) == who)
                } else {
                    p.agents.iter().any(|a| Some(a.as_str()) == who)
                };
                if !belongs {
                    return bad("assignee must belong to project");
                }
            }
            let ci = card_idx(d, id)?;
            let present = arr(&d.cards[ci], "assignees")
                .iter()
                .any(|a| same(a, assignee));
            if add == present {
                return Ok(d.cards[ci].clone());
            }
            let mut list = arr(&d.cards[ci], "assignees").to_vec();
            if add {
                list.push(assignee.clone());
            } else {
                list.retain(|a| !same(a, assignee));
            }
            d.cards[ci].set("assignees", J::Arr(list));
            self.history(
                d,
                ci,
                if add { "assigned" } else { "unassigned" },
                actor,
                &assignee.stringify(),
            );
            Ok(d.cards[ci].clone())
        })
    }

    /// `archiveCard`.
    pub fn board_archive_card(
        &self,
        project_id: &str,
        id: &str,
        archived: bool,
        actor: &J,
        over: bool,
    ) -> R<J> {
        self.write_board(project_id, |_, d| {
            let ci = card_idx(d, id)?;
            if (d.cards[ci].get("archived") == Some(&J::Bool(true))) == archived {
                return Ok(d.cards[ci].clone());
            }
            if !archived {
                let col = gs(&d.cards[ci], "columnId").to_owned();
                self.wip(d, &col, 1, over)?;
            }
            d.cards[ci].set("archived", J::Bool(archived));
            let detail = J::obj([("override", J::Bool(over))]).stringify();
            self.history(
                d,
                ci,
                if archived { "archived" } else { "unarchived" },
                actor,
                &detail,
            );
            Ok(d.cards[ci].clone())
        })
    }

    /// `comment`.
    pub fn board_comment(&self, project_id: &str, id: &str, text: &str, actor: &J) -> R<J> {
        self.write_board(project_id, |_, d| {
            let ci = card_idx(d, id)?;
            if js_trim(text).is_empty() || utf16_len(text) > 65_536 {
                return bad("invalid comment");
            }
            let comment = J::obj([
                ("id", J::Str(format!("{:0>16}", d.comments.len() + 1))),
                ("cardId", J::s(id)),
                ("text", J::s(text)),
                ("author", actor_copy(actor)),
                ("createdAt", J::Num(self.clock.now() as f64)),
            ]);
            d.comments.push(comment.clone());
            let cid = gs(&comment, "id").to_owned();
            self.history(d, ci, "commented", actor, &cid);
            Ok(comment)
        })
    }

    /// `comments(projectId, id, input)`.
    pub fn board_comments(
        &self,
        project_id: &str,
        id: &str,
        cursor: Option<&str>,
        take: Option<f64>,
    ) -> R<Page> {
        let d = self.read_only(project_id)?;
        card_idx(&d, id)?;
        let items: Vec<J> = d
            .comments
            .iter()
            .filter(|c| gs(c, "cardId") == id)
            .cloned()
            .collect();
        let binding = J::Arr(vec![J::s(project_id), J::s(id), J::s("comments")]);
        page(items, cursor, take, &binding, false)
    }

    /// `activity(projectId, id, input)`.
    pub fn board_activity(
        &self,
        project_id: &str,
        id: &str,
        cursor: Option<&str>,
        take: Option<f64>,
    ) -> R<Page> {
        let d = self.read_only(project_id)?;
        card_idx(&d, id)?;
        let items: Vec<J> = d
            .activity
            .iter()
            .filter(|c| gs(c, "cardId") == id)
            .cloned()
            .collect();
        let binding = J::Arr(vec![J::s(project_id), J::s(id), J::s("activity")]);
        page(items, cursor, take, &binding, false)
    }

    /// Whether a live project exists for the board (used by the service before it touches the board).
    pub fn board_project_live(&self, project_id: &str) -> R<bool> {
        Ok(live_in(self.conn()?, &self.config(), project_id).is_ok())
    }
}
