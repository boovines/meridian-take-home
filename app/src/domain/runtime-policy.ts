// Liveness tolerance is separate from the bounded operation deadline.
export const RUNTIME_HEARTBEAT_POLICY = {
  version: 1,
  interval_ms: 5_000,
  timeout_ms: 60_000,
  max_throttle_ms: 5_000,
} as const;
