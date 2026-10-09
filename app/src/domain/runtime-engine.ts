import type {
  RuntimeDefinition,
  RuntimeError,
  RuntimeProjection,
  ScheduleStep,
  StepReply,
} from "./runtime";

export interface RuntimePorts {
  now(): number;
  scriptedHuman?: boolean;
  rethrow?(error: unknown): void;
  describeFailure?(error: unknown): RuntimeError;
  step(data: ScheduleStep, resume?: boolean): Promise<StepReply>;
  human(requestId: string, stopped: () => boolean): Promise<void>;
  project(state: RuntimeProjection): Promise<void>;
  changed(): void;
}
export class RuntimeEngine {
  private paths = 1;
  private waiting = 0;
  private elapsed = 0;
  private since: number | null;
  private sequence = 0;
  private scheduled = 0;
  private visits: Record<string, number> = {};
  private outputs: Record<string, { id: string; occurrence: number }> = {};
  failure: RuntimeError | null = null;
  resultStepId: string | null = null;
  constructor(
    private runId: string,
    private definition: RuntimeDefinition,
    private ports: RuntimePorts,
    private phaseNodeId: string | null = null,
  ) {
    this.since = ports.now();
  }
  activeElapsed() {
    return (
      this.elapsed +
      (this.since === null ? 0 : Math.max(0, this.ports.now() - this.since))
    );
  }
  remaining() {
    return this.definition.limits.active_ms - this.activeElapsed();
  }
  isWaiting() {
    return this.paths > 0 && this.waiting === this.paths;
  }
  private change(paths = 0, waiting = 0) {
    this.elapsed = this.activeElapsed();
    this.paths += paths;
    this.waiting += waiting;
    this.since = this.paths === 0 || this.isWaiting() ? null : this.ports.now();
    this.sequence++;
    this.ports.changed();
  }
  projection(): RuntimeProjection {
    return {
      sequence: this.sequence,
      status: this.isWaiting() ? "waiting_for_human" : "running",
      scheduled_step_attempts: this.scheduled,
      active_elapsed_ms: this.elapsed,
      active_since:
        this.since === null ? null : new Date(this.since).toISOString(),
    };
  }
  stop(error: RuntimeError) {
    this.failure ??= error;
    this.ports.changed();
  }
  private fail(error: unknown) {
    if (this.ports.describeFailure) {
      this.stop(this.ports.describeFailure(error));
      return;
    }
    const message =
      error instanceof Error
        ? error.message
        : "The runtime could not complete this step.";
    const split = message.indexOf(":");
    this.stop({
      code: split > 0 ? message.slice(0, split) : "RUNTIME_FAILED",
      message: message.slice(0, 2000),
      category: "implementation",
    });
  }
  async run() {
    const triggers = this.definition.board.nodes.filter(
      (n) => n.type === "trigger",
    );
    if (triggers.length !== 1)
      throw new Error("Exactly one frozen trigger is required.");
    if (
      this.phaseNodeId &&
      !this.definition.board.nodes.some(
        (n) =>
          n.id === this.phaseNodeId && ["trigger", "outcome"].includes(n.type),
      )
    )
      throw new Error(
        "A grouped phase must execute its approved trigger or outcome.",
      );
    await this.walk(this.phaseNodeId ?? triggers[0].id, null, null);
    this.change(-1);
    return {
      status: this.failure
        ? ((this.failure.code === "RUN_LIMIT"
            ? "needs_attention"
            : "failed") as "needs_attention" | "failed")
        : ("completed" as const),
      error: this.failure,
      result_step_id: this.resultStepId,
      projection: this.projection(),
    };
  }
  private async walk(
    start: string,
    stopAt: string | null,
    branch: string | null,
    outputs = this.outputs,
  ): Promise<void> {
    let nodeId = start;
    while (nodeId !== stopAt && !this.failure) {
      try {
        if (
          this.scheduled >= this.definition.limits.step_attempts ||
          this.remaining() <= 0
        ) {
          this.stop({
            code: "RUN_LIMIT",
            message: "The run reached its fixed execution limit.",
            category: "implementation",
          });
          return;
        }
        const node = this.definition.board.nodes.find((n) => n.id === nodeId);
        if (!node)
          throw new Error(
            "INVALID_NODE: A scheduled node is absent from the frozen process.",
          );
        const occurrence = ++this.scheduled;
        const data: ScheduleStep = {
          run_id: this.runId,
          node_id: nodeId,
          occurrence_number: occurrence,
          node_visit_number: (this.visits[nodeId] =
            (this.visits[nodeId] || 0) + 1),
          scheduling_key: `step-${occurrence}`,
          branch_ref: branch,
          input_step_refs: Object.fromEntries(
            Object.entries(outputs).map(([id, ref]) => [id, ref.id]),
          ),
        };
        this.change();
        await this.ports.project(this.projection());
        if (this.failure) return;
        let result = await this.ports.step(data);
        if (result.kind === "human") {
          if (!this.ports.scriptedHuman) this.change(0, 1);
          await this.ports.project(this.projection());
          try {
            await this.ports.human(result.request_id, () => !!this.failure);
          } finally {
            if (!this.ports.scriptedHuman) this.change(0, -1);
          }
          await this.ports.project(this.projection());
          if (this.failure) return;
          result = await this.ports.step(data, true);
        }
        if (result.kind === "human")
          throw new Error(
            "REPEATED_HUMAN_REQUEST: A step requested another response on the same visit.",
          );
        if (result.kind === "error") {
          this.stop(result.error);
          return;
        }
        // Preserve an already-running sibling's output even after another fails.
        outputs[nodeId] = { id: result.step_id, occurrence };
        if (this.failure) return;
        if (node.id === this.phaseNodeId || node.type === "outcome") {
          this.resultStepId = result.step_id;
          return;
        }
        const outgoing = this.definition.board.connections.filter((e) =>
          result.connection_ids.includes(e.id),
        );
        if (node.split_mode === "parallel") {
          const merge = this.definition.board.nodes.find(
            (n) => n.join_for_split_id === node.id,
          );
          if (!merge || outgoing.length < 2)
            throw new Error(
              "INVALID_PARALLEL_REGION: A split needs its paired merge and branches.",
            );
          const branchOutputs = outgoing.map(() => ({ ...outputs }));
          this.change(outgoing.length - 1);
          await Promise.all(
            outgoing.map(async (edge, index) => {
              try {
                await this.walk(
                  edge.target_node_id,
                  merge.id,
                  `${data.scheduling_key}/${edge.id}`,
                  branchOutputs[index],
                );
              } finally {
                this.change(-1);
              }
            }),
          );
          this.change(1);
          if (this.failure) return;
          // Siblings see the split snapshot plus their own path until joining.
          for (const branchState of branchOutputs)
            for (const [id, ref] of Object.entries(branchState)) {
              if (!outputs[id] || ref.occurrence > outputs[id].occurrence)
                outputs[id] = ref;
            }
          nodeId = merge.id;
        } else {
          if (outgoing.length !== 1)
            throw new Error(
              "INVALID_ROUTING: A non-parallel step must select exactly one connection.",
            );
          nodeId = outgoing[0].target_node_id;
        }
      } catch (error) {
        this.ports.rethrow?.(error);
        this.fail(error);
        return;
      }
    }
  }
}
