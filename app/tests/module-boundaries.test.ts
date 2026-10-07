import { resolve } from "node:path";
import { ESLint } from "eslint";
import { expect, it } from "vitest";

const eslint = new ESLint({ cwd: resolve(import.meta.dirname, "..") });
async function boundaryErrors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.filter(
    (message) => message.ruleId === "no-restricted-imports",
  );
}

it.each([
  [
    "src/domain/probe.ts",
    'import { workflow } from "../server/workflows/store";',
  ],
  [
    "src/domain/probe.ts",
    'import { workflow } from "@/server/workflows/store";',
  ],
  ["src/domain/probe.ts", 'import { readFile } from "node:fs";'],
  [
    "src/components/evaluations/probe.ts",
    'import { db } from "../../server/database";',
  ],
  ["src/lib/probe.ts", 'import { executeWorkflow } from "@/worker/workflows";'],
  [
    "src/worker/probe-workflow.ts",
    'import * as activities from "./runtime-activities";',
  ],
  ["src/worker/probe-workflow.ts", 'import { db } from "../server/database";'],
  [
    "src/worker/probe-workflow.ts",
    'import { Client } from "@temporalio/client";',
  ],
])("rejects prohibited dependencies in %s: %s", async (filePath, source) => {
  expect(await boundaryErrors(filePath, source)).not.toHaveLength(0);
});

it.each([
  [
    "src/worker/probe-workflow.ts",
    'import type * as activities from "./runtime-activities";',
  ],
  [
    "src/worker/probe-workflow.ts",
    'import { proxyActivities } from "@temporalio/workflow";',
  ],
  [
    "src/components/evaluations/probe.ts",
    'import type { EvaluationRun } from "@/domain/evaluation";',
  ],
])(
  "allows supported dependency directions in %s: %s",
  async (filePath, source) => {
    expect(await boundaryErrors(filePath, source)).toHaveLength(0);
  },
);
