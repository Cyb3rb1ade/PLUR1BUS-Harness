//! The platform-neutral half of the Windows pipe checks (ruling S11): the DACL entry a report yields, the rule that
//! decides whether another account may write to a pipe, and the SDDL of the supervisor pipe. The Windows calls that
//! produce and apply them live in `win` (compiled on Windows only); these parts are unit-tested on every OS.

/// `S-1-5-18`, LocalSystem.
pub const SYSTEM_SID: &str = "S-1-5-18";
/// `S-1-5-32-544`, BUILTIN\Administrators.
pub const ADMINISTRATORS_SID: &str = "S-1-5-32-544";
/// `S-1-3-4`, OWNER RIGHTS.
pub const OWNER_RIGHTS_SID: &str = "S-1-3-4";

/// `FILE_WRITE_DATA` (for a pipe: write a request).
pub const FILE_WRITE_DATA: u32 = 0x0000_0002;
/// `FILE_CREATE_PIPE_INSTANCE` (for a pipe: serve the name too, i.e. take connections meant for the server).
pub const FILE_CREATE_PIPE_INSTANCE: u32 = 0x0000_0004;
/// `WRITE_DAC` (rewrite the DACL, then grant oneself anything).
pub const WRITE_DAC: u32 = 0x0004_0000;
/// `WRITE_OWNER` (take ownership, then rewrite the DACL).
pub const WRITE_OWNER: u32 = 0x0008_0000;
/// `GENERIC_WRITE`.
pub const GENERIC_WRITE: u32 = 0x4000_0000;
/// `GENERIC_ALL`.
pub const GENERIC_ALL: u32 = 0x1000_0000;

/// One access-allowed or access-denied ACE of a DACL, with its SID as a string (`S-1-…`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaclEntry {
    pub sid: String,
    pub mask: u32,
    pub allow: bool,
}

/// Rights that let another account write requests, serve the pipe itself, or give itself either.
const WRITE_LIKE: u32 = FILE_WRITE_DATA
    | FILE_CREATE_PIPE_INSTANCE
    | WRITE_DAC
    | WRITE_OWNER
    | GENERIC_WRITE
    | GENERIC_ALL;

/// The SIDs that may write to the object: allow entries with `FILE_WRITE_DATA`, `FILE_CREATE_PIPE_INSTANCE`,
/// `WRITE_DAC`, `WRITE_OWNER`, `GENERIC_WRITE` or `GENERIC_ALL` for any SID other than `user_sid`, SYSTEM,
/// Administrators and OWNER RIGHTS. Sorted, each once.
pub fn writable_by_others(entries: &[DaclEntry], user_sid: &str) -> Vec<String> {
    let trusted = [user_sid, SYSTEM_SID, ADMINISTRATORS_SID, OWNER_RIGHTS_SID];
    let mut sids: Vec<String> = entries
        .iter()
        .filter(|e| e.allow && e.mask & WRITE_LIKE != 0)
        .filter(|e| !trusted.contains(&e.sid.as_str()))
        .map(|e| e.sid.clone())
        .collect();
    sids.sort();
    sids.dedup();
    sids
}

/// The protected DACL of the supervisor pipe and of `run/supervisor.token`/`.pid`: full control for the user and
/// SYSTEM, nothing inherited, nobody else.
pub fn user_and_system_sddl(user_sid: &str) -> String {
    format!("D:P(A;;GA;;;{user_sid})(A;;GA;;;SY)")
}

/// `OBJECT_INHERIT_ACE`: files created in the directory inherit the ACE.
pub const OBJECT_INHERIT_ACE: u8 = 0x01;
/// `CONTAINER_INHERIT_ACE`: subdirectories created in the directory inherit the ACE.
pub const CONTAINER_INHERIT_ACE: u8 = 0x02;
/// `INHERITED_ACE`: the ACE came from the parent's inheritable ACEs.
pub const INHERITED_ACE: u8 = 0x10;
/// `SE_DACL_PROTECTED`: the security descriptor's DACL takes nothing from its parent.
pub const SE_DACL_PROTECTED: u16 = 0x1000;

/// The DACL the supervisor sets on `run/` once at start (HB5, DS36): protected (nothing inherited from the home),
/// full file access for the user and SYSTEM, both inherited by every file (`OI`) and subdirectory (`CI`) created in
/// it later, so a child's token and pid files are user-and-SYSTEM-only from their first byte, with no `icacls` run.
pub fn run_dir_sddl(user_sid: &str) -> String {
    format!("D:P(A;OICI;FA;;;{user_sid})(A;OICI;FA;;;SY)")
}

/// The SIDs that may write to `run/` or one of its token/pid files: the same write-like rights as
/// [`writable_by_others`], but trusting only `user_sid` and SYSTEM — unlike a pipe's default DACL, `run/`'s ACL
/// (ruling S11: `icacls <p> /inheritance:r /grant:r *<user SID>:(F) *S-1-5-18:(F)`) never names Administrators or
/// OWNER RIGHTS, so an entry for either here is itself unexpected and reported. Sorted, each once.
pub fn run_writable_by_others(entries: &[DaclEntry], user_sid: &str) -> Vec<String> {
    let trusted = [user_sid, SYSTEM_SID];
    let mut sids: Vec<String> = entries
        .iter()
        .filter(|e| e.allow && e.mask & WRITE_LIKE != 0)
        .filter(|e| !trusted.contains(&e.sid.as_str()))
        .map(|e| e.sid.clone())
        .collect();
    sids.sort();
    sids.dedup();
    sids
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = "S-1-5-21-1111111111-2222222222-3333333333-1001";

    fn allow(sid: &str, mask: u32) -> DaclEntry {
        DaclEntry {
            sid: sid.into(),
            mask,
            allow: true,
        }
    }

    #[test]
    fn the_supervisor_pipe_sddl_grants_only_the_user_and_system() {
        assert_eq!(
            user_and_system_sddl(USER),
            format!("D:P(A;;GA;;;{USER})(A;;GA;;;SY)")
        );
    }

    #[test]
    fn run_dir_sddl_is_protected_and_inheritable_for_the_user_and_system_only() {
        assert_eq!(
            run_dir_sddl(USER),
            format!("D:P(A;OICI;FA;;;{USER})(A;OICI;FA;;;SY)")
        );
    }

    #[test]
    fn node_default_pipe_dacl_is_not_writable_by_others() {
        // Node's default pipe DACL as GetSecurityInfo reports it: full control for SYSTEM, Administrators and the
        // creator (the user), FILE_GENERIC_READ for Everyone and Anonymous.
        let entries = [
            allow(SYSTEM_SID, 0x001F_01FF),
            allow(ADMINISTRATORS_SID, 0x001F_01FF),
            allow(USER, 0x001F_01FF),
            allow("S-1-1-0", 0x0012_0089),
            allow("S-1-5-7", 0x0012_0089),
            allow(OWNER_RIGHTS_SID, 0x001F_01FF),
        ];
        assert!(writable_by_others(&entries, USER).is_empty());
    }

    #[test]
    fn write_data_generic_write_or_generic_all_for_another_sid_is_reported_once_and_sorted() {
        let entries = [
            allow("S-1-5-32-545", FILE_WRITE_DATA),
            allow("S-1-1-0", GENERIC_WRITE),
            allow("S-1-5-11", GENERIC_ALL),
            allow("S-1-1-0", GENERIC_ALL),
            allow("S-1-5-7", 0x0012_0089),
            DaclEntry {
                sid: "S-1-5-2".into(),
                mask: GENERIC_ALL,
                allow: false,
            },
        ];
        assert_eq!(
            writable_by_others(&entries, USER),
            ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]
        );
    }

    #[test]
    fn run_dacl_with_only_the_user_and_system_is_not_writable_by_others() {
        // S11's `run/` ACL: `icacls <p> /inheritance:r /grant:r *<user SID>:(F) *S-1-5-18:(F)` — user and SYSTEM
        // only, full control, nothing inherited.
        let entries = [allow(USER, 0x001F_01FF), allow(SYSTEM_SID, 0x001F_01FF)];
        assert!(run_writable_by_others(&entries, USER).is_empty());
    }

    #[test]
    fn run_dacl_trusts_neither_administrators_nor_owner_rights_unlike_a_pipe() {
        // Unlike `writable_by_others` (a pipe's default DACL, which legitimately includes Administrators and OWNER
        // RIGHTS), `run/`'s ACL never names either, so their presence here is itself reported (ruling H3-R17).
        let entries = [
            allow(USER, 0x001F_01FF),
            allow(SYSTEM_SID, 0x001F_01FF),
            allow(ADMINISTRATORS_SID, 0x001F_01FF),
            allow(OWNER_RIGHTS_SID, 0x001F_01FF),
        ];
        assert_eq!(
            run_writable_by_others(&entries, USER),
            [OWNER_RIGHTS_SID, ADMINISTRATORS_SID]
        );
    }

    #[test]
    fn run_dacl_flags_everyone_users_or_authenticated_users_with_write_like_rights() {
        let entries = [
            allow(USER, 0x001F_01FF),
            allow(SYSTEM_SID, 0x001F_01FF),
            allow("S-1-1-0", FILE_WRITE_DATA),    // Everyone
            allow("S-1-5-32-545", GENERIC_WRITE), // Users
            allow("S-1-5-11", GENERIC_ALL),       // Authenticated Users
        ];
        assert_eq!(
            run_writable_by_others(&entries, USER),
            ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]
        );
    }

    #[test]
    fn creating_a_pipe_instance_or_rewriting_the_dacl_or_owner_counts_as_writable() {
        let entries = [
            allow("S-1-5-32-545", FILE_CREATE_PIPE_INSTANCE),
            allow("S-1-1-0", WRITE_DAC),
            allow("S-1-5-11", WRITE_OWNER),
            allow(USER, FILE_CREATE_PIPE_INSTANCE | WRITE_DAC | WRITE_OWNER),
            allow(SYSTEM_SID, WRITE_DAC),
        ];
        assert_eq!(
            writable_by_others(&entries, USER),
            ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]
        );
    }
}
