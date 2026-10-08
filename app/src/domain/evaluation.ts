import { z } from "zod";
import { uuid, revisionSchema } from "./validation";
import { humanResponse, type Json } from "./runtime";
const key = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
  .max(100);
export const assertionSchema = z
  .object({
    key,
    label: z.string().trim().min(1).max(300),
    path: z.array(z.string().max(200)).max(20),
    operator: z
      .enum(["equals", "contains_record", "excludes_record"])
      .optional(),
    expected: z.json(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (
      a.operator &&
      a.operator !== "equals" &&
      (a.expected === null ||
        typeof a.expected !== "object" ||
        Array.isArray(a.expected) ||
        Object.keys(a.expected).length === 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["expected"],
        message:
          "Record checks require a nonempty JSON object of fields to match.",
      });
  });
export const scriptedResponse = z
  .object({
    node_id: uuid,
    node_visit_number: z.number().int().positive().max(100),
    response: humanResponse,
  })
  .strict();
export const caseInput = z
  .object({
    case_key: key,
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["workflow", "step"]),
    node_id: uuid.nullable().default(null),
    input_bundle_id: uuid.nullable().default(null),
    input_data: z
      .object({
        input: z.json(),
        steps: z.record(uuid, z.json()),
        human_response: humanResponse.optional(),
      })
      .strict()
      .nullable()
      .default(null),
    human_responses: z.array(scriptedResponse).max(100).default([]),
    assertions: z.array(assertionSchema).min(1).max(100),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      c.kind === "workflow"
        ? !c.input_bundle_id || c.node_id !== null || c.input_data !== null
        : !c.node_id ||
          !c.input_data ||
          c.human_responses.length > 0
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Workflow cases require a captured bundle; step cases require a node and context.",
        path: ["kind"],
      });
    if (new Set(c.assertions.map((a) => a.key)).size !== c.assertions.length)
      ctx.addIssue({
        code: "custom",
        message: "Assertion keys must be unique.",
        path: ["assertions"],
      });
    if (
      new Set(
        c.human_responses.map((h) => `${h.node_id}/${h.node_visit_number}`),
      ).size !== c.human_responses.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Each human visit can have one scripted response.",
        path: ["human_responses"],
      });
  });
export const createSuiteInput = z
  .object({
    request_key: uuid,
    name: z.string().trim().min(1).max(200),
    parent_suite_version_id: uuid.nullable().default(null),
  })
  .strict();
export const editCaseInput = z
  .object({ expected_revision: revisionSchema, case: caseInput })
  .strict();
export const verifyInput = z
  .object({ expected_revision: revisionSchema })
  .strict();
export const startEvaluationInput = z
  .object({
    request_key: uuid,
    implementation_version_id: uuid,
    suite_version_id: uuid,
  })
  .strict();
export interface SuiteVersion {
  id: string;
  workflow_id: string;
  frozen_spec_id: string;
  version_number: number;
  parent_suite_version_id: string | null;
  name: string;
  state: "draft" | "locked";
  revision: number;
  locked_at: string | null;
  created_at: string;
}
export interface EvaluationCase extends z.infer<typeof caseInput> {
  id: string;
  workflow_id: string;
  suite_version_id: string;
  revision: number;
  verified_at: string | null;
}
export interface AssertionResult {
  key: string;
  label: string;
  passed: boolean;
  actual: Json | null;
  missing: boolean;
}
export interface EvaluationRun {
  execution_configuration: Json;
  code_version_number?: number;
  suite_version_number?: number;
  id: string;
  workflow_id: string;
  job_id: string;
  implementation_version_id: string;
  suite_version_id: string;
  status: "queued" | "running" | "completed" | "blocked" | "cancelled";
  verdict: "passed" | "failed" | "inconclusive" | null;
  failure_category: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
}
export interface CaseResult {
  workflow_run_id?: string | null;
  id: string;
  workflow_id: string;
  evaluation_run_id: string;
  suite_version_id: string;
  case_id: string;
  status: "queued" | "running" | "finished";
  outcome: "passed" | "failed" | "error" | "not_run" | null;
  actual_output: Json | null;
  check_results: AssertionResult[];
  failure_category: string | null;
  failure_code: string | null;
  failure_message: string | null;
}
