"use client";
import { useState } from "react";
import type { ComponentProps } from "react";
import { RunPanel } from "../runtime/run-panel";
import { GroupedRunPanel } from "./grouped-run-panel";
export function WorkflowRunPanel(props: ComponentProps<typeof RunPanel>) {
  const [mode, setMode] = useState("Selected emails");
  return (
    <>
      <nav className="button-row agent-tools" aria-label="Run input type">
        {["Selected emails", "Saved input"].map((value) => (
          <button
            key={value}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {value}
          </button>
        ))}
      </nav>
      {mode === "Selected emails" ? (
        <GroupedRunPanel {...props} />
      ) : (
        <RunPanel {...props} />
      )}
    </>
  );
}
