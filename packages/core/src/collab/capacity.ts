/** D124 CPU and memory are measured soft bounds; disk admission belongs to the provisioner-backed scheduler. */
import type { CollaborationTeamsConfig } from '@plur1bus/config-schema';
import { DEFAULT_COLLAB_LIMITS } from './limits.ts';

export interface CapacityFacts {
  cores: number;
  availableMemory: number;
  totalMemory?: number;
  settings: CollaborationTeamsConfig['capacity'];
}
export interface WriterCapacity {
  computed: number;
  slots: number;
  exceeded: boolean;
}

/** Shared CPU/memory admission; the service enforces each project's writer count separately. */
export function writerCapacity(perProject: number, facts: CapacityFacts, runningLocalWriters = 0): WriterCapacity {
  // Existing writers already consumed part of the measured free memory; do not count their reservation twice.
  const memory = Math.min(facts.totalMemory ?? Number.MAX_SAFE_INTEGER,
    facts.availableMemory + runningLocalWriters * facts.settings.memoryPerWriter);
  const computed = Math.max(1, Math.min(
    Math.floor(facts.cores / facts.settings.coresPerWriter),
    Math.floor(memory / facts.settings.memoryPerWriter),
  ));
  // A changed project limit can explicitly overcommit hardware, but a smaller project cannot
  // narrow the machine's shared capacity for unrelated projects. An explicit capacity override can.
  const slots = facts.settings.maxWriters
    ?? Math.max(computed, perProject === DEFAULT_COLLAB_LIMITS.writers.perProject ? 0 : perProject);
  return { computed, slots, exceeded: slots > computed };
}
