import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { createDatabase } from "../src/server/database";
it("upgrades a populated v1 database without rewriting the sealed graph or review history", async () => {
  const db = await createDatabase();
  try {
    await db.exec(
      "CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql") && n < "016")
      .sort())
      await db.exec(await readFile(`migrations/${name}`, "utf8"));
    const wid = randomUUID(),
      sid = randomUUID(),
      rid = randomUUID();
    const graph = {
      workflow: { id: wid, name: "Legacy frozen process" },
      nodes: [],
      connections: [],
    };
    const evidence = { decision: "Original expert-approved evidence" };
    await db.query("INSERT INTO workflows(id,name) VALUES($1,$2)", [
      wid,
      "Legacy frozen process",
    ]);
    await db.query(
      "INSERT INTO frozen_specs(id,workflow_id,source_content_revision,graph,review_evidence) VALUES($1,$2,0,$3,$4)",
      [sid, wid, graph, evidence],
    );
    await db.query("UPDATE workflows SET state='frozen' WHERE id=$1", [wid]);
    await db.exec(
      await readFile("migrations/016_process_revisions.sql", "utf8"),
    );
    expect(
      (
        await db.query(
          "SELECT process_version,current_frozen_spec_id,base_frozen_spec_id FROM workflows WHERE id=$1",
          [wid],
        )
      ).rows[0],
    ).toEqual({
      process_version: 1,
      current_frozen_spec_id: sid,
      base_frozen_spec_id: null,
    });
    expect(
      (
        await db.query(
          "SELECT graph,review_evidence,version_number,parent_frozen_spec_id FROM frozen_specs WHERE id=$1",
          [sid],
        )
      ).rows[0],
    ).toEqual({
      graph,
      review_evidence: evidence,
      version_number: 1,
      parent_frozen_spec_id: null,
    });
    await expect(
      db.query("UPDATE frozen_specs SET graph='{}' WHERE id=$1", [sid]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE workflows SET state='draft' WHERE id=$1", [wid]),
    ).rejects.toMatchObject({ code: "23514" });
    await db.query(
      "UPDATE workflows SET state='draft',process_version=2,base_frozen_spec_id=$2 WHERE id=$1",
      [wid, sid],
    );
    await expect(
      db.query(
        "INSERT INTO frozen_specs(id,workflow_id,source_content_revision,graph,review_evidence,version_number,parent_frozen_spec_id) VALUES($1,$2,0,$3,$4,3,$5)",
        [rid, wid, graph, evidence, sid],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  } finally {
    await db.close();
  }
});
