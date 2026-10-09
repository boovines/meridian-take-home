import type {
  ScopingOperation,
  Scope,
  Scaffold,
} from "../../src/domain/scoping";
export const readyScope: Scope = {
  summary:
    "Receive a request, prepare a response, and let a person approve it before producing the result.",
  coverage: {
    trigger: "A request is submitted manually.",
    outcome: "An approved response is ready; nothing is sent automatically.",
    steps:
      "Read the request, prepare a response, obtain approval, show the result.",
    routing:
      "If rejected, revise the response and ask again. Approval reaches the outcome.",
    humans: "The process owner approves or rejects the response.",
    exceptions:
      "Missing information is flagged for the process owner during preparation.",
  },
  blockers: [],
  assumptions: ["The process owner is the approver."],
  unresolved: [
    {
      key: "retention",
      question: "How long should the approved response be retained?",
    },
  ],
};
export const readyScaffold: Scaffold = {
  desired_outcome:
    "Prepare a human-approved response without sending it automatically.",
  nodes: [
    {
      key: "start",
      type: "trigger",
      title: "Receive request",
      instructions: "Start when the process owner selects a request.",
      split_mode: null,
      join_for_split_key: null,
    },
    {
      key: "prepare",
      type: "task",
      title: "Prepare response",
      instructions:
        "Read the request and prepare a response. Flag missing information for the owner; incorporate feedback on rejection.",
      split_mode: null,
      join_for_split_key: null,
    },
    {
      key: "approve",
      type: "human_approval",
      title: "Approve response",
      instructions:
        "The process owner approves the response or provides revision feedback.",
      split_mode: "exclusive",
      join_for_split_key: null,
    },
    {
      key: "result",
      type: "outcome",
      title: "Preview approved response",
      instructions: "Show the approved response. Do not send it automatically.",
      split_mode: null,
      join_for_split_key: null,
    },
  ],
  connections: [
    {
      key: "begin",
      source: "start",
      target: "prepare",
      condition_text: "",
      is_default: false,
    },
    {
      key: "approval",
      source: "prepare",
      target: "approve",
      condition_text: "",
      is_default: false,
    },
    {
      key: "approved",
      source: "approve",
      target: "result",
      condition_text: "The owner approved the response",
      is_default: false,
    },
    {
      key: "revise",
      source: "approve",
      target: "prepare",
      condition_text: "The owner requested revisions",
      is_default: false,
    },
  ],
  unresolved_anchors: [
    { key: "retention", node_keys: ["result"], connection_keys: [] },
  ],
};
// Deliberately fixed scenario for CI only; never masquerades as live synthesis.
export function fixtureScope(op: ScopingOperation) {
  if (op.kind === "preview")
    return {
      message:
        "Here is a connected draft with human approval and a revision loop. Inspect it before applying; retention remains a review question.",
      graph: readyScaffold,
    };
  if (op.input.action === "start")
    return {
      message:
        "Who approves the response, and what should happen if they request changes? I recommend returning to preparation so their feedback can be incorporated.",
      scope: {
        ...readyScope,
        coverage: { ...readyScope.coverage, humans: null, routing: null },
        blockers: ["Confirm who approves and how rejection continues."],
      },
    };
  return {
    message:
      "The scope is ready. Confirm the summary and assumptions to generate a preview. Retention can be resolved during normal review.",
    scope: { ...readyScope, blockers: [] },
  };
}
