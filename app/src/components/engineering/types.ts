import type { Board, Workflow } from "@/domain/canvas";
import type {
  Plan,
  PlanStep,
  ImplementationVersion,
  WorkflowJob,
} from "@/domain/engineering";
import type { Project } from "@/domain/project";
export interface EngineeringState {
  workflow: Workflow;
  spec: { id: string; board: Board };
  plans: Plan[];
  steps: PlanStep[];
  versions: ImplementationVersion[];
  jobs: WorkflowJob[];
}
export interface VersionDetail {
  build_check_status: "passed" | "failed" | null;
  evaluation: {
    id: string;
    status: string;
    failure_code?: string | null;
    verdict: string | null;
    suite_number: number;
  } | null;
  version: ImplementationVersion;
  project: Project;
  changes: { path: string; status: string; before: string | null }[];
}
