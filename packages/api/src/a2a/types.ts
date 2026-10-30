export const A2A_MAX_BODY_BYTES = 1024 * 1024;
export const A2A_DEFAULT_PAGE_SIZE = 50;
export const A2A_MAX_TASKS_PER_OWNER = 1000;

export const A2A_TASK_LIMITS = {
  maxTextBytes: 64 * 1024,
  maxParts: 16,
  maxHistoryLength: 20,
  maxReplyBytes: 256 * 1024,
  maxLiveTasksPerPeer: 8,
} as const;

export const REPLY_TRUNCATED_MARKER = "[reply truncated: size limit]";


