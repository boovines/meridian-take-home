import { DomainError } from "../../domain/errors";
import type { Workflow } from "../../domain/canvas";
import type { DiscussionThread } from "../../domain/review";
import { editable } from "../workflows/store";
/** Discussion can continue on a locked source spec; accepting edits cannot. */
export function discussable(w: Workflow, thread: DiscussionThread) {
  const request = thread.engineer_request;
  if (request) {
    if (w.state === "reviewing")
      throw new DomainError(
        409,
        "REVIEW_ACTIVE",
        "Finish or cancel the review before continuing the conversation.",
      );
    const current =
      request.target_process_version === w.process_version ||
      (request.target_process_version === null &&
        request.source_frozen_spec_id === w.current_frozen_spec_id);
    if (!current)
      throw new DomainError(
        409,
        "HISTORICAL_REQUEST",
        "This request belongs to an earlier handoff and remains read-only.",
      );
    return;
  }
  editable(w);
  if (thread.kind === "finding" && thread.process_version !== w.process_version)
    throw new DomainError(
      409,
      "HISTORICAL_FINDING",
      "This finding belongs to an earlier process revision and remains read-only.",
    );
}
