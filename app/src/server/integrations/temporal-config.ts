export function temporalConfig() {
  const namespace = process.env.TEMPORAL_NAMESPACE;
  const address = process.env.TEMPORAL_ADDRESS;
  if (!namespace || !address)
    throw new Error("Configure the Temporal address and namespace.");
  return {
    namespace,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE || "meridian-studio",
    connection: {
      address,
      tls: process.env.TEMPORAL_TLS !== "false",
      apiKey: process.env.TEMPORAL_API_KEY,
      metadata: { "temporal-namespace": namespace },
    },
  };
}
