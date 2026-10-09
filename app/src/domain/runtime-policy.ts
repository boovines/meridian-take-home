// Liveness tolerance is separate from the bounded operation deadline.
export const RUNTIME_HEARTBEAT_POLICY = {
  version: 1,
  interval_ms: 5_000,
  timeout_ms: 60_000,
  max_throttle_ms: 5_000,
} as const;

// Two independent cases, each of which may run two extraction branches.
export const EVALUATION_SCHEDULING_POLICY = {
  version: 1,
  case_concurrency: 2,
} as const;
export const WORKER_ACTIVITY_CONCURRENCY = 4;
