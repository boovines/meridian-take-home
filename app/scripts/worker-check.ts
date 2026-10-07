import { bundleWorkflowCode } from "@temporalio/worker";
import path from "node:path";
await bundleWorkflowCode({
  workflowsPath: path.resolve("src/worker/workflows.ts"),
});
console.log("Temporal workflows bundle successfully.");
