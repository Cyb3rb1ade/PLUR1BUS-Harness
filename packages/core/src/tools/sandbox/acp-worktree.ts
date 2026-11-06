/** #820 compatibility names; ACP and native coding share the same opaque provisioner identity. */
import { WorktreeMount, validateWorktreeMount } from './worktree-mount.ts';
export type AcpWorktreeMount = WorktreeMount;
export const AcpWorktreeMount = Object.freeze({ fromStore: WorktreeMount.forAcp });
export const validateAcpMount = validateWorktreeMount;
