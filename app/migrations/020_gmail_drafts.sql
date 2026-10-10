CREATE TABLE gmail_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workflow_id uuid NOT NULL,
 run_id uuid NOT NULL,
 account_id text NOT NULL,
 message_id text NOT NULL,
 subject text NOT NULL,
 body text NOT NULL,
 recipient text NOT NULL,
 state text NOT NULL CHECK(state IN ('creating','created','uncertain')),
 draft_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,account_id,message_id),
 FOREIGN KEY(workflow_id,run_id) REFERENCES workflow_runs(workflow_id,id),
 CHECK((state='created')=(draft_id IS NOT NULL))
);
ALTER TABLE gmail_drafts ENABLE ROW LEVEL SECURITY;
CREATE TABLE gmail_draft_settings (
 workflow_id uuid PRIMARY KEY REFERENCES workflows(id),
 enabled boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gmail_draft_settings ENABLE ROW LEVEL SECURITY;
