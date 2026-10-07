import type { NextConfig } from "next";
const config: NextConfig = {
  turbopack: { root: process.cwd() },
  agentRules: false,
};
export default config;
