//! Bind narrative input to locked actual source revisions and original current policy.
use super::*;
use crate::neo::{episodes, narrative, participant_names::ParticipantNames};

pub(super) fn enrich(
    input: &Build<'_>,
    episodes: &mut [Json],
    open: Option<&Json>,
    rows: &HashMap<JsString, Json>,
    names: &ParticipantNames,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    let Some(port) = input.narrative else {
        return Ok(());
    };
    let prior = open.map(|v| array(v, "turns")).transpose()?.unwrap_or(&[]);
    for episode in episodes {
        let ids = strings(array(episode, "memoryIds")?)?;
        if ids.len() < 2 {
            continue;
        }
        let mut group = Vec::new();
        for id in &ids {
            let original = source(rows, id, input.ctx)?;
            let snapshot = prior
                .iter()
                .find(|v| journal_io::id(v).ok().as_ref() == Some(id));
            let mut turn = snapshot.unwrap_or(original).clone();
            if snapshot.is_some() {
                // The authenticated full source proves the saved snapshot's exact UTF-16 cut.
                // Drop only its introduced final half-pair at the external model boundary.
                let full = field(original, "content").ok_or(StoreError::Corrupt)?;
                let full = super::super::merged_order::string(full);
                narrative::utf8(&full)?;
                set(
                    &mut turn,
                    "content",
                    Json::String(narrative::display_cut(&full, 600)),
                )?;
            }
            group.push(turn);
        }
        let check = || -> Result<(), EngineError> {
            (input.check)()?;
            let current = sources(input.dir, cancel)?;
            for id in &ids {
                if source(&current, id, input.ctx)? != source(rows, id, input.ctx)? {
                    return Err(StoreError::InvalidInput.into());
                }
            }
            (input.check)()?;
            Ok(())
        };
        check()?;
        let enriched = narrative::enrich(
            episode,
            &group,
            Some((&names.user, &names.assistant)),
            Some(port),
            cancel,
        )?;
        check()?;
        *episode = enriched;
        let now = episodes::time(&Json::String(input.now.clone()))?;
        let vividness = episodes::vividness(episode, now)?;
        set(
            episode,
            "vividness",
            crate::capture::dynamics::json_number(vividness),
        )?;
    }
    Ok(())
}
