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

// Provider response time starts after preflight. The step cap also bounds batches.
// The unchanged 15-minute run limit remains authoritative over all activities.
export const RUNTIME_DEADLINE_POLICY = {
  version: 1,
  model_response_ms: 180_000,
  step_ms: 720_000,
  activity_ms: 750_000,
  activity_schedule_ms: 900_000,
  model_sdk_retries: 0,
} as const;
