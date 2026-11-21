//! Clock-driven state transitions. The simulated lease has no authority outside this model.

use super::{valid_id, Error};
use serde::{Deserialize, Serialize};

/// Time limit for one simulated lease.
pub const LEASE_TTL: u64 = 120_000;
/// Time from lease issuance until the next heartbeat is due.
pub const HEARTBEAT: u64 = 30_000;
/// Longest admitted mission lifetime.
pub const MAX_DURATION: u64 = 2_592_000_000;

/// Contents of an offer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Offer {
    /// Mission identifier.
    pub loan_id: String,
    /// Loaned agent.
    pub agent_id: String,
    /// Lender identity reference.
    pub lender_fingerprint: String,
    /// Borrower identity reference.
    pub borrower_fingerprint: String,
    /// Creation time in milliseconds.
    pub created_at: u64,
    /// Absolute end.
    pub expires_at: u64,
    /// Whether completed copies may be retained by the borrower.
    pub keep_mission_copies: bool,
    /// Catalogue references only.
    pub secret_names: Vec<String>,
}

/// Local side of the simulation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    /// Originator of the offer.
    Lender,
    /// Receiver of the offer.
    Borrower,
}

/// Local lifecycle.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    /// Offer presented.
    Offered,
    /// Offer accepted, awaiting lease.
    Accepted,
    /// Active lease.
    Active,
    /// Lease timed out before the mission did.
    Paused,
    /// Borrower returned mission.
    Returned,
    /// Remote-peer grace expired.
    ReturnedByTimeout,
    /// Lender recalled mission.
    Recalled,
    /// Mission revoked.
    Revoked,
    /// Offer lifetime ended.
    Expired,
    /// Offer declined.
    Declined,
}

/// Unsigned lease schedule from the model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaseCandidate {
    /// Mission.
    pub loan_id: String,
    /// Loaned agent.
    pub agent_id: String,
    /// Bound borrower identity.
    pub borrower_fingerprint: String,
    /// Issuance instant.
    pub issued_at: u64,
    /// Exclusive end.
    pub not_after: u64,
}

/// One external clock observation or local simulation event.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Event {
    /// Accept under one borrower-local project.
    Accept {
        /// Borrower-local context.
        #[serde(rename = "borrowerProjectId")]
        borrower_project_id: Option<String>,
    },
    /// Renew a simulated lease.
    Renew {
        /// Untrusted simulation data.
        lease: LeaseCandidate,
    },
    /// Observe the current clock.
    Tick,
    /// Lender recall.
    Recall,
    /// Revoke the mission.
    Revoke,
    /// Borrower return.
    Return,
    /// Decline prior to acceptance.
    Decline,
    /// Confirm local removal after terminal transition.
    ConfirmRemoval,
}

/// Validated local state. Network input must enter through a fresh offer or typed event.
#[derive(Clone, Debug)]
#[cfg_attr(test, derive(Serialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct State {
    offer: Offer,
    side: Side,
    status: Status,
    observed_at: u64,
    #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
    borrower_project_id: Option<String>,
    #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
    last_contact_at: Option<u64>,
    #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
    lease: Option<LeaseCandidate>,
    #[cfg_attr(test, serde(skip_serializing_if = "Option::is_none"))]
    next_heartbeat_at: Option<u64>,
    removal_confirmed: bool,
}

/// Content-free projection with no borrower project identity.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LenderView<'a> {
    offer: &'a Offer,
    status: Status,
    removal_confirmed: bool,
}

const BORROWER_GRACE: u64 = 86_400_000;
const LENDER_GRACE: u64 = 900_000;
const MAX_SECRET_NAMES: usize = 128;
const MAX_TIME: u64 = crate::budget::MAX_SAFE as u64;

impl Status {
    /// Whether this mission can no longer be renewed or accepted.
    pub fn terminal(self) -> bool {
        !matches!(
            self,
            Self::Offered | Self::Accepted | Self::Active | Self::Paused
        )
    }
}

impl Offer {
    pub(super) fn check(&self) -> Result<(), Error> {
        time(self.created_at)?;
        time(self.expires_at)?;
        if !self
            .expires_at
            .checked_sub(self.created_at)
            .is_some_and(|n| (1..=MAX_DURATION).contains(&n))
        {
            return Err(Error("loan-model: invalid duration"));
        }
        for (id, error) in [
            (&self.loan_id, "loan-model: invalid loanId"),
            (&self.agent_id, "loan-model: invalid agentId"),
            (
                &self.lender_fingerprint,
                "loan-model: invalid lenderFingerprint",
            ),
            (
                &self.borrower_fingerprint,
                "loan-model: invalid borrowerFingerprint",
            ),
        ] {
            if !valid_id(id) {
                return Err(Error(error));
            }
        }
        if self.lender_fingerprint == self.borrower_fingerprint {
            return Err(Error("loan-model: same peer"));
        }
        if self.secret_names.len() > MAX_SECRET_NAMES
            || self.secret_names.iter().any(|name| !reference_name(name))
        {
            return Err(Error("loan-model: invalid secret name"));
        }
        Ok(())
    }
}
fn reference_name(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'/' | b'-'))
}
fn time(n: u64) -> Result<(), Error> {
    if n > MAX_TIME {
        return Err(Error("loan-model: invalid time"));
    }
    Ok(())
}
fn transition_error() -> Error {
    Error("loan-model: invalid transition")
}

impl State {
    /// Create the simulation from an inspected offer.
    pub fn new(offer: Offer, side: Side, now: u64) -> Result<Self, Error> {
        time(now)?;
        time(offer.created_at)?;
        if now < offer.created_at {
            return Err(Error("loan-model: invalid time"));
        }
        offer.check()?;
        let status = if now >= offer.expires_at {
            Status::Expired
        } else {
            Status::Offered
        };
        Ok(Self {
            offer,
            side,
            status,
            observed_at: now,
            borrower_project_id: None,
            last_contact_at: None,
            lease: None,
            next_heartbeat_at: None,
            removal_confirmed: false,
        })
    }

    fn observed(&self, now: u64) -> Result<Self, Error> {
        time(now)?;
        if now < self.observed_at {
            return Err(Error("loan-model: time rollback"));
        }
        let mut next = self.clone();
        next.observed_at = now;
        if self.status.terminal() {
            return Ok(next);
        }
        let grace = match self.side {
            Side::Lender => LENDER_GRACE,
            Side::Borrower => BORROWER_GRACE,
        };
        if now >= self.offer.expires_at {
            next.status = Status::Expired;
        } else if self
            .last_contact_at
            .is_some_and(|last| now.saturating_sub(last) >= grace)
        {
            next.status = Status::ReturnedByTimeout;
        } else if self.status == Status::Active
            && self
                .lease
                .as_ref()
                .is_some_and(|lease| now >= lease.not_after)
        {
            next.status = Status::Paused;
        }
        Ok(next)
    }

    /// Apply a local event to a current time observation.
    pub fn transition(&self, event: Event, now: u64) -> Result<Self, Error> {
        let mut next = self.observed(now)?;
        if matches!(event, Event::Tick) {
            return Ok(next);
        }
        if matches!(event, Event::ConfirmRemoval) {
            if !next.status.terminal() {
                return Err(transition_error());
            }
            next.removal_confirmed = true;
            return Ok(next);
        }
        if next.status.terminal() {
            return Err(Error("loan-model: mission ended"));
        }
        match event {
            Event::Accept {
                borrower_project_id,
            } => next.accept(borrower_project_id, now)?,
            Event::Renew { lease } => next.renew(lease, now)?,
            Event::Recall => next.status = Status::Recalled,
            Event::Revoke => next.status = Status::Revoked,
            Event::Return if next.status != Status::Offered => next.status = Status::Returned,
            Event::Decline if next.status == Status::Offered => next.status = Status::Declined,
            _ => return Err(transition_error()),
        }
        Ok(next)
    }

    fn accept(&mut self, project: Option<String>, now: u64) -> Result<(), Error> {
        if self.status != Status::Offered {
            return Err(transition_error());
        }
        match self.side {
            Side::Borrower => {
                let project = project
                    .filter(|project| valid_id(project))
                    .ok_or(Error("loan-model: invalid borrower project"))?;
                self.borrower_project_id = Some(project);
            }
            Side::Lender if project.is_some() => {
                return Err(Error("loan-model: borrower project is local"))
            }
            Side::Lender => {}
        }
        self.status = Status::Accepted;
        self.last_contact_at = Some(now);
        Ok(())
    }

    fn renew(&mut self, lease: LeaseCandidate, now: u64) -> Result<(), Error> {
        if !matches!(
            self.status,
            Status::Accepted | Status::Active | Status::Paused
        ) {
            return Err(transition_error());
        }
        time(lease.issued_at)?;
        time(lease.not_after)?;
        let last_contact = self
            .last_contact_at
            .ok_or(Error("loan-model: invalid lease"))?;
        if lease.loan_id != self.offer.loan_id
            || lease.agent_id != self.offer.agent_id
            || lease.borrower_fingerprint != self.offer.borrower_fingerprint
            || lease.issued_at > now
            || lease.issued_at < last_contact
            || lease.not_after <= now
            || lease.not_after <= lease.issued_at
            || lease.not_after - lease.issued_at > LEASE_TTL
            || lease.not_after > self.offer.expires_at
            || self.lease.as_ref().is_some_and(|previous| {
                lease.issued_at <= previous.issued_at || lease.not_after < previous.not_after
            })
        {
            return Err(Error("loan-model: invalid lease"));
        }
        self.status = Status::Active;
        self.next_heartbeat_at = Some((lease.issued_at + HEARTBEAT).min(self.offer.expires_at));
        self.lease = Some(lease);
        self.last_contact_at = Some(now);
        Ok(())
    }

    /// Compute an unsigned future lease for simulation only.
    pub fn model_lease(&self, now: u64) -> Result<LeaseCandidate, Error> {
        time(now)?;
        if now < self.observed_at || now >= self.offer.expires_at {
            return Err(Error("loan-model: invalid lease time"));
        }
        Ok(LeaseCandidate {
            loan_id: self.offer.loan_id.clone(),
            agent_id: self.offer.agent_id.clone(),
            borrower_fingerprint: self.offer.borrower_fingerprint.clone(),
            issued_at: now,
            not_after: (now + LEASE_TTL).min(self.offer.expires_at),
        })
    }

    /// Simulate work in the exact project under the current lease.
    pub fn work_allowed(&self, project: Option<&str>, now: u64) -> bool {
        let Ok(observed) = self.observed(now) else {
            return false;
        };
        observed.side == Side::Borrower
            && observed.status == Status::Active
            && observed
                .lease
                .as_ref()
                .is_some_and(|lease| now < lease.not_after)
            && observed
                .project()
                .is_some_and(|bound| Some(bound) == project)
    }

    /// Latest simulated lease.
    pub fn lease(&self) -> Option<&LeaseCandidate> {
        self.lease.as_ref()
    }

    /// Portable lender view.
    pub fn lender_view(&self) -> LenderView<'_> {
        LenderView {
            offer: &self.offer,
            status: self.status,
            removal_confirmed: self.removal_confirmed,
        }
    }

    /// Current offer.
    pub fn offer(&self) -> &Offer {
        &self.offer
    }

    /// Local side.
    pub fn side(&self) -> Side {
        self.side
    }

    /// Local borrower project binding.
    pub fn project(&self) -> Option<&str> {
        self.borrower_project_id.as_deref()
    }
}

#[cfg(test)]
#[path = "loan_vectors.rs"]
mod vectors;
