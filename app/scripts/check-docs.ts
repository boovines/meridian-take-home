import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Check local inline Markdown links and reachability, without fetching external URLs. */
export function inspectDocumentation(root: string, files: string[]): string[] {
  const errors: string[] = [];
  const links = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(resolve(root, file), "utf8")
      .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "")
      .replace(/`[^`\n]*`/g, "");
    const destinations: string[] = [];
    for (const match of text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
      const target = match[1] || match[2];
      if (/^(?:[a-z][\w+.-]*:|\/|#)/i.test(target)) continue;
      const path = decodeURIComponent(target.split(/[?#]/)[0]);
      const absolute = resolve(root, dirname(file), path);
      if (!existsSync(absolute)) errors.push(`${file}: missing link target ${target}`);
      destinations.push(relative(root, absolute).replaceAll("\\", "/"));
    }
    links.set(file, destinations);
  }
  const reachable = new Set<string>();
  const visit = (file: string) => {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const destination of links.get(file) || []) visit(destination);
  };
  visit("docs/README.md");
  for (const file of files) {
    if (file.startsWith("docs/") && !reachable.has(file)) {
      errors.push(`${file}: not reachable from docs/README.md`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"], { cwd: root, encoding: "utf8" }).trim().split("\n"))]
    .filter((file) => file.endsWith(".md") && existsSync(resolve(root, file)));
  const errors = inspectDocumentation(root, files);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Documentation links and navigation checked across ${files.length} Markdown files.`);
  }
}
