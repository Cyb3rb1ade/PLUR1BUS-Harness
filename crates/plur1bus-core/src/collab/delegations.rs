//! Turn-local ownership and collection of child delegations.
use super::errors::{CollabError, CollabErrorCode as C};
use super::store::R;
use crate::logs::methods::AbortSignal;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// A report and any provenance carried by the target adapter.
pub struct ChildOutput {
    /// The validated return envelope.
    pub report: Value,
    /// Provenance supplied by the adapter.
    pub provenance: Option<Value>,
}

/// An opaque delivery claim.
pub struct DeliveryReceipt(Arc<()>);

/// Results and outstanding children from a collection attempt.
#[derive(Default)]
pub struct Collection {
    /// The available results in request order.
    pub results: Vec<Value>,
    /// The children still running.
    pub running: Vec<String>,
    /// The claim to settle after attempting delivery.
    pub receipt: Option<DeliveryReceipt>,
}

impl Collection {
    /// The TypeScript wait result, with the Rust receipt kept out of the result.
    pub fn to_value(&self) -> Value {
        json!({ "results": self.results, "running": self.running })
    }
}

struct Child {
    task_id: String,
    project_id: String,
    card_bound: bool,
    abort: AbortSignal,
    provenance: Value,
    result: Option<Value>,
    claim: Option<Arc<()>>,
    reported: bool,
}

/// The starting turn's view over its children.
#[derive(Default)]
pub struct TurnDelegations {
    children: Vec<Child>,
    ids: HashMap<String, usize>,
    finishing: bool,
}

impl TurnDelegations {
    fn index(&self, task_id: &str) -> R<usize> {
        self.ids
            .get(task_id)
            .copied()
            .ok_or_else(|| CollabError::new(C::NotFound, "delegation does not belong to this turn"))
    }

    /// Register a child before starting work.
    pub fn start(
        &mut self,
        task_id: &str,
        project_id: &str,
        card_bound: bool,
        abort: AbortSignal,
        origin: Value,
    ) -> R<()> {
        if self.finishing {
            return Err(CollabError::new(
                C::Aborted,
                "delegating turn already ended",
            ));
        }
        if self.ids.contains_key(task_id) {
            return Err(CollabError::new(
                C::Conflict,
                "delegation already belongs to this turn",
            ));
        }
        let mut provenance = match origin {
            Value::Object(fields) => fields,
            _ => Default::default(),
        };
        provenance.insert("projectId".to_owned(), json!(project_id));
        provenance.insert("taskId".to_owned(), json!(task_id));
        self.ids.insert(task_id.to_owned(), self.children.len());
        self.children.push(Child {
            task_id: task_id.to_owned(),
            project_id: project_id.to_owned(),
            card_bound,
            abort,
            provenance: Value::Object(provenance),
            result: None,
            claim: None,
            reported: false,
        });
        Ok(())
    }

    /// Publish a child's completed result.
    pub fn complete(&mut self, task_id: &str, outcome: R<ChildOutput>) -> R<()> {
        let idx = self.index(task_id)?;
        let child = &mut self.children[idx];
        if child.result.is_some() {
            return Err(CollabError::new(
                C::Conflict,
                "delegation already completed",
            ));
        }
        child.result = Some(match outcome {
            Ok(o) => json!({ "kind": "tool_result", "trust": "untrusted", "taskId": task_id,
                "provenance": o.provenance.unwrap_or_else(|| child.provenance.clone()), "result": o.report }),
            Err(error) => {
                let code = if error.is_typed() {
                    error.code.as_str()
                } else {
                    "invalid"
                };
                let detail = error.guardrail.map_or(code, |r| r.as_str());
                let message = if error.is_typed() {
                    format!("delegation failed ({detail})")
                } else {
                    "delegation failed".to_owned()
                };
                json!({ "kind": "tool_result", "trust": "untrusted", "taskId": task_id,
                    "provenance": child.provenance, "error": { "code": code, "message": message } })
            }
        });
        Ok(())
    }

    /// Collect ready results by id without waiting in the library.
    pub fn collect(
        &mut self,
        task_ids: &[&str],
        abort: &AbortSignal,
        require_receipt: bool,
    ) -> R<Collection> {
        let mut seen = HashSet::new();
        let indices = task_ids
            .iter()
            .filter(|id| seen.insert(**id))
            .map(|id| self.index(id))
            .collect::<R<Vec<_>>>()?;
        if abort.is_aborted() {
            return Err(CollabError::new(C::Aborted, "delegation wait cancelled"));
        }
        Ok(self.claim(indices, require_receipt))
    }

    fn claim(&mut self, indices: Vec<usize>, require_receipt: bool) -> Collection {
        let claim = require_receipt.then(|| Arc::new(()));
        let mut collection = Collection::default();
        for index in indices {
            let child = &mut self.children[index];
            let Some(result) = &child.result else {
                collection.running.push(child.task_id.clone());
                continue;
            };
            if child.reported || child.claim.is_some() {
                continue;
            }
            child.claim = claim.clone();
            child.reported = !require_receipt;
            collection.results.push(result.clone());
        }
        if !collection.results.is_empty() {
            collection.receipt = claim.map(DeliveryReceipt);
        }
        collection
    }

    /// Find projects of children of this turn.
    pub fn projects(&self, task_ids: &[&str]) -> R<Vec<String>> {
        let mut projects = Vec::new();
        let mut seen = HashSet::new();
        for id in task_ids {
            let project = &self.children[self.index(id)?].project_id;
            if seen.insert(project) {
                projects.push(project.clone());
            }
        }
        Ok(projects)
    }

    /// Accept or release a claim. Repeated and stale receipts are harmless.
    pub fn settle(&mut self, receipt: &DeliveryReceipt, accepted: bool) {
        for child in &mut self.children {
            if child
                .claim
                .as_ref()
                .is_some_and(|claim| Arc::ptr_eq(claim, &receipt.0))
            {
                child.reported = accepted;
                child.claim = None;
            }
        }
    }

    /// Cancel unbound children when ownership is transferred.
    pub fn cancel_unbound(&self, except: &str) {
        for child in &self.children {
            if child.task_id != except && !child.card_bound && child.result.is_none() {
                child.abort.abort();
            }
        }
    }

    /// End admission, ask children to abort if requested, and collect once the join is ready.
    /// A host owns any wait between calls and may observe each child's progress independently.
    pub fn finish(&mut self, cancel: bool, require_receipt: bool) -> Collection {
        self.finishing = true;
        if cancel {
            for child in &self.children {
                child.abort.abort();
            }
        }
        if self.is_closed() {
            self.claim((0..self.children.len()).collect(), require_receipt)
        } else {
            Collection {
                running: self
                    .children
                    .iter()
                    .filter(|c| c.result.is_none())
                    .map(|c| c.task_id.clone())
                    .collect(),
                ..Collection::default()
            }
        }
    }

    /// True once the turn is ending and all children have settled.
    pub fn is_closed(&self) -> bool {
        self.finishing && self.children.iter().all(|c| c.result.is_some())
    }
}

#[cfg(test)]
#[path = "delegation_vectors.rs"]
mod vectors;
