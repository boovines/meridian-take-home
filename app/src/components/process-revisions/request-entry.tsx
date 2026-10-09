"use client";
import "./revisions.css";
import { Dialog } from "../dialog";
import {
  RequestForm,
  RequestStatus,
  useRequestDraft,
  type RequestEntryProps,
} from "./request-form";
export function RequestEntry({ state }: RequestEntryProps) {
  const draft = useRequestDraft(state);
  return (
    <div className="request-compact">
      <button
        disabled={state.spec.id !== state.workflow.current_frozen_spec_id}
        onClick={() => draft.setOpen(true)}
      >
        Request changes
      </button>
      <RequestStatus state={state} sent={draft.sent} />
      {draft.open && (
        <Dialog
          labelledBy="request-title"
          onClose={() => {
            if (!draft.busy) draft.setOpen(false);
          }}
        >
          <h2 id="request-title">Request process changes</h2>
          <RequestForm state={state} draft={draft} />
        </Dialog>
      )}
    </div>
  );
}
