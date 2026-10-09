import type { NextConfig } from "next";
const config: NextConfig = {
  turbopack: { root: process.cwd() },
  agentRules: false,
  outputFileTracingIncludes: { "/*": ["./migrations/*.sql"] },
  serverExternalPackages: ["@temporalio/client"],
};
export default config;
