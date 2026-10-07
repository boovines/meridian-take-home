import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/server/**",
                "**/worker/**",
                "**/components/**",
                "**/app/**",
              ],
              message:
                "Domain contracts and rules must not depend on application layers.",
            },
            {
              group: [
                "node:*",
                "react",
                "react/*",
                "next",
                "next/*",
                "@temporalio/*",
                "@supabase/*",
                "@vercel/*",
              ],
              message:
                "Keep domain code pure; put framework and provider implementations in their owning layer.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/components/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/server/**", "**/worker/**"],
              message:
                "Browser code uses domain contracts and HTTP APIs, not server or worker modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/worker/*workflow*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/server/**",
                "**/*activities",
                "node:*",
                "pg",
                "@temporalio/client",
                "@temporalio/worker",
                "@supabase/*",
                "@vercel/*",
                "ai",
                "@ai-sdk/*",
              ],
              allowTypeImports: true,
              message:
                "Deterministic workflows invoke typed activity proxies; I/O belongs in activities and server adapters.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);
