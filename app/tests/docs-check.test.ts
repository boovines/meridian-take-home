import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectDocumentation } from "../scripts/check-docs";

const roots: string[] = [];
function documentation(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "meridian-docs-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return inspectDocumentation(root, Object.keys(files));
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it("follows section indexes and cycles while ignoring external URLs and code examples", () => {
  expect(documentation({
    "docs/README.md": '[Guide](features/index.md#intro) [Web](https://example.com)\n`[example](missing.md)`\n```md\n[example](missing.md)\n```',
    "docs/features/index.md": '[Back](../README.md) [Feature](feature.md)',
    "docs/features/feature.md": '[Guide](index.md)',
  })).toEqual([]);
});

it("reports both broken references and documents omitted from navigation", () => {
  expect(documentation({
    "docs/README.md": '[Removed](features/removed.md)',
    "docs/orphan.md": '# Forgotten document',
  })).toEqual([
    "docs/README.md: missing link target features/removed.md",
    "docs/orphan.md: not reachable from docs/README.md",
  ]);
});
