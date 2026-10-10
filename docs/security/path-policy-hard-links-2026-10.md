# Path policy: hard links and deny-list `name` entries

Status: implemented in `packages/core/src/policy/paths.ts` (`nameEntryAlias`, `openVerified`). Closes the known gap that
`permission-eval-e2e` carried as `path-hard-link-to-name-entry`.

## The gap

A deny-list entry is either a `path` (a file or a tree) or a `name` (`.env`, `.ssh`: any path segment with that spelling).
`path` entries are resolved to identities, so a hard link to a file below one is recognised whatever it is called. A `name`
entry cannot be resolved to a place, so it matched by spelling only: `ln .env notes.txt` inside a root made the secret readable
as `notes.txt`.

## Variant chosen: identity scan of the roots, not "refuse every link count > 1"

Refusing every regular file with `nlink > 1` in a root that has name rules would be complete and cheap, and it would also block
pnpm stores, `node_modules` trees, `cp -l` snapshots and build caches, which are legitimate. So:

1. Only when the target is an existing regular file with link count > 1 **and** the deny-list contains a `name` entry, every
   root is walked once. Symbolic links are not followed.
2. A file is protected when its own name, or the name of any directory above it up to and including the root's whole real
   path, matches a `name` entry (same NFC/case folding as the spelling check, `matchDeny`).
3. If the target's `dev:ino` equals that of a protected file, the request is refused with `deny-listed`. On Windows the pair is
   the volume serial number and the NTFS file index, which Node reports in the same fields.
4. **Fail closed:** a walk that exceeds the cap (100 000 entries), or meets a directory or file it cannot read for any reason
   other than "gone", is "unknown" and refuses the hard-linked target. A workspace larger than the cap therefore cannot read
   hard-linked files while a name rule is in force; set a `path` entry instead of a `name` entry for such trees, or split the root.

Targets with link count 1, and every request when the deny-list has no `name` entry, never trigger the walk.

## Time of check, time of use

The scan decides on the identity of the file, and `openVerified` opens the leaf with `O_NOFOLLOW` and compares the identity of
the **opened handle** with the checked one, so a path swapped for a link to `.env` after the check is `identity-changed`. When
name entries were in force, a read also fails with `hard-link` if the opened file gained a link since the check.

## Residual risk

A protected file **outside every root** cannot be found by the walk. A hard link inside a root to such a file is only caught
when the file is also covered by a `path` entry (`denyEntriesFor` lists the well-known credential files that way). Reading a hard
link to an unprotected outside file stays allowed on purpose (`path-hard-link-write-outside` benign row); writing to any
hard-linked file is refused, as before.
