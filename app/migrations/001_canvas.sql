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
