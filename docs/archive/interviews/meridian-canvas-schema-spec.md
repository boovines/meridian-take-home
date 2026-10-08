# Meridian canvas schema

> Archived interview/design record. Some proposed tables and execution responsibilities were intentionally superseded during implementation. Start with the [documentation index](../../README.md) and [current data-model audit](../../architecture/data-model.md); executable fields and constraints live in [migrations](../../../app/migrations).

Step 3, canvas portion — October 7, 2026. Design proposal only; no database migration has been executed. Builds on the [entity model](meridian-entity-model-spec.md).

## Recommendation

Keep editable nodes and connections relational. Use a complete immutable JSON snapshot at freeze, because generation consumes the approved graph as a whole. Put variable primitive settings in a validated JSON object, while identity, routing relationships, concurrency, and layout have ordinary columns. JSON remains structured data with a documented contract, not an arbitrary dumping ground. PostgreSQL supports relational and JSON representations together; updating a JSON value still locks its containing row. [JSON documentation](https://www.postgresql.org/docs/current/datatype-json.html)

## Proposed fields and local constraints

The SQL below defines storage shape and row/relationship constraints. Mutation functions, graph validation, and immutable-snapshot enforcement described afterward are required before using this as an implementation.

```sql
CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'Untitled workflow'
    CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  desired_outcome text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'reviewing', 'frozen')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  content_revision bigint NOT NULL DEFAULT 0 CHECK (content_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  type text NOT NULL CHECK (type IN (
    'trigger', 'information', 'task', 'check',
    'human_handoff', 'human_approval', 'outcome'
  )),
  title text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  x double precision NOT NULL DEFAULT 0,
  y double precision NOT NULL DEFAULT 0,
  split_mode text CHECK (split_mode IN ('exclusive', 'parallel')),
  join_for_split_id uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (workflow_id, id),
  FOREIGN KEY (workflow_id, join_for_split_id)
    REFERENCES nodes(workflow_id, id),
  CHECK (join_for_split_id IS NULL OR join_for_split_id <> id)
);

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  source_node_id uuid NOT NULL,
  target_node_id uuid NOT NULL,
  condition_text text NOT NULL DEFAULT '',
  is_default boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (workflow_id, id),
  FOREIGN KEY (workflow_id, source_node_id)
    REFERENCES nodes(workflow_id, id),
  FOREIGN KEY (workflow_id, target_node_id)
    REFERENCES nodes(workflow_id, id),
  CHECK (NOT is_default OR condition_text = '')
);

CREATE TABLE frozen_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL UNIQUE REFERENCES workflows(id),
  source_content_revision bigint NOT NULL CHECK (source_content_revision >= 0),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  graph jsonb NOT NULL CHECK (jsonb_typeof(graph) = 'object'),
  review_evidence jsonb NOT NULL CHECK (jsonb_typeof(review_evidence) = 'object'),
  unreviewed_changes_acknowledged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, id)
);

CREATE UNIQUE INDEX nodes_one_active_merge_per_split
  ON nodes(workflow_id, join_for_split_id)
  WHERE deleted_at IS NULL AND join_for_split_id IS NOT NULL;

CREATE UNIQUE INDEX connections_one_active_default
  ON connections(workflow_id, source_node_id)
  WHERE deleted_at IS NULL AND is_default;

CREATE INDEX connections_active_outgoing
  ON connections(workflow_id, source_node_id) WHERE deleted_at IS NULL;
CREATE INDEX connections_active_incoming
  ON connections(workflow_id, target_node_id) WHERE deleted_at IS NULL;
CREATE INDEX workflows_recent
  ON workflows(updated_at DESC, id DESC);
```

All fields without `NOT NULL` are intentionally nullable: split/merge settings need not exist on ordinary nodes, and `deleted_at` is null for active records. Blank node titles and instructions are permitted while drafting; completeness is checked before freeze. Reject non-finite coordinates at the mutation boundary. `updated_at` and revisions require explicit mutation logic; defaults only initialize them.

The composite foreign keys prevent cross-workflow connections and merge references. The supporting `(workflow_id, id)` uniqueness is additional to the global ID primary key; it supports these ownership constraints and workflow-scoped reads. A foreign key checks existence, not whether its target is logically deleted. Graph mutations and freeze validation enforce active-target rules. PostgreSQL foreign keys, uniqueness, and row-local checks serve different purposes; graph-wide rules are not ordinary `CHECK` constraints. [Constraint documentation](https://www.postgresql.org/docs/current/ddl-constraints.html)

## Field semantics

- **Desired outcome:** `workflows.desired_outcome` records the customer's plain-language goal, separately from terminal Outcome blocks. It can be blank during drafting. If missing, the review clarification stage asks the customer to supply or confirm it before evaluating which steps contribute to the goal. AI must not silently infer and approve the goal on the customer's behalf.
- **Instructions:** canonical plain-language requirements. UI prompts help write this field; review conversation is not a substitute for it. Do not maintain an independently editable duplicate in `config`.
- **Config:** schema-validated settings keyed by `type` and `config_version`. Examples include trigger input settings or a human request's response format. Concrete per-type contracts remain to be defined; JSON object shape alone is insufficient validation. Persistent relationships such as attachment ownership must use explicit relationships in the later artifact schema, not unchecked IDs hidden in config.
- **Split mode:** null on an ordinary single-successor node, `exclusive` or `parallel` when it branches. Instructions and conditions remain prose at freeze; implementation supplies their execution logic.
- **Merge:** `join_for_split_id` identifies the parallel split whose launched branches must finish. This relationship is separate from the merge node's own outgoing routing, so a node can merge one section and start another.
- **Otherwise:** `is_default = true` has no condition text; the UI renders “Otherwise.” It is available only on exclusive splits. Connections have no priority or execution-order field.
- **Revisions:** per-record `revision` protects against stale writes. `workflows.revision` protects workflow metadata/state edits. `content_revision` advances once per committed semantic mutation, including desired-outcome changes, node definitions, routes, additions, and deletions. Position-only changes update the node revision, not content revision. This counter is a freshness marker, not a history store.
- **Frozen snapshot:** `graph` contains the workflow name, desired outcome, entry node ID, active nodes and connections, their IDs/definitions/configuration/routing, and layout for reproduction. `review_evidence` preserves the relevant review references, finding dispositions, and explanations. Its exact contract follows the review schema. `schema_version` versions the snapshot format, not customer revisions. The unique workflow ID intentionally allows only one frozen spec in the demo.

## Freeze validation and execution contract

Confirmed in this interview:

1. Require exactly one active Trigger at freeze. Incomplete drafts are allowed. Multiple triggers are future scope.
2. Every active process node must be reachable from that trigger. Disconnected blocks must be connected or removed; do not silently omit them.
3. Every parallel split has one explicitly paired merge. Branches reunite there; overlapping/crossing parallel regions are outside demo scope. Pair validation must account for branch membership and exits, not merely check that a merge reference exists.
4. Exclusive routing requires one matching non-default condition. Multiple matches stop execution with a routing-ambiguity error. No matches use Otherwise if present, or stop with a no-matching-route error. Do not select by connection insertion order or canvas position.

Recommended additional deterministic checks: active connection endpoints; valid, active parallel split references; required titles and per-type configuration; explicit mode for branching nodes; at least two branches on a parallel split; no Otherwise route on a non-exclusive split; and no conditional branch selection on a run-all parallel split. Validate at least one terminal Outcome, no outgoing edges from Outcome nodes, no incoming edges to the entry Trigger, and a possible route to an Outcome from each active node. These are proposed completeness rules, not additional user-confirmed scope decisions. A possible exit does not prove a loop terminates; runtime loop budgets remain part of execution design.

Freeze requires at least one completed review and all review findings addressed, including eligible target-deleted closures. Compare the latest completed review's analyzed content revision with the current revision; require acknowledgment when the current content is unreviewed. Customer notes do not block freeze. The [review schema](meridian-review-schema-spec.md) defines the active-review reference and freshness rules, extending the illustrative DDL above.

Review must also suggest simplifications, including removal of potentially extraneous primitives, with rationale tied to the customer-confirmed desired outcome and stated constraints. These are customer-decided findings, not structural validation errors; the AI cannot delete or reconnect nodes. Clarify an unclear intended outcome or step purpose before asserting redundancy.

Parallel execution waits for the branches launched by a particular split occurrence. It must not count all incoming edges or reuse completion from a previous loop visit. The runtime schema will represent those occurrences.

## Transactions and access patterns

Use one controlled mutation path, with direct client writes unable to bypass it. Each graph mutation, review-state transition, and freeze operation acquires a short transaction lock on the workflow row first, checks state, then changes child records. Never hold this lock during an LLM call. PostgreSQL row locks last for the transaction and coordinate competing writers. [Locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html)

- **Edit:** require draft state; update the specific record with its expected revision and `deleted_at IS NULL`. On mismatch, reject without overwriting and preserve client text. Advance the relevant revisions and timestamps in the same transaction. Workflow IDs and record IDs are immutable.
- **Delete:** logically delete the node and incident connections, update their revisions, clear active merge references to a deleted split (leaving any incomplete graph for explicit repair), and perform eligible finding closures together. Do not physically cascade away history.
- **Review:** set the lock state and create the review record atomically. Completion/cancellation must check the active review identity before returning to draft; late results from a canceled run cannot unlock or publish into a newer review. The identity field/foreign key will be added with the review schema.
- **Confirm a missing goal during review:** this is an explicit customer action through the active clarification session, not an ordinary unlocked canvas edit. The review-schema pass must provide a controlled update that checks the active review identity, records the confirmed goal, advances content revision, and binds subsequent analysis/publication to that revised input. General canvas editing stays locked. Results produced against an earlier goal/revision must not be published as current.
- **Freeze:** require draft state and the content revision the customer confirmed, validate the graph and findings under the workflow lock, insert the immutable snapshot, and set frozen state together. Repeated freeze requests return the existing spec. Reject snapshot updates/deletes through database enforcement as well as the API; this enforcement is not implemented by the illustrative DDL above.
- **Load:** retrieve workflow metadata and its active nodes/connections. The frozen editor loads its saved snapshot. Node lookups use ID; graph loading uses workflow ID. Existing composite indexes are a starting point; do not add a JSON search index without a JSON-search query.

The workflow lock briefly serializes saves to one board, but edits to different boards remain independent. Per-node revisions prevent unrelated edits from being rejected just because another node changed. Save canvas positions at drag completion or in bounded batches, not for every pointer movement. Revisit this coordination strategy if actual same-board contention becomes material; do not add collaboration infrastructure speculatively.

The [review schema](meridian-review-schema-spec.md) now defines review runs, typed discussion threads, messages, and anchors, including their effects on the shared workflow state. No SQL here has been executed or claimed to pass a live database test.
