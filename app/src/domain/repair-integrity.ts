import { parse, tokTypes, type Token } from "acorn";
import { DomainError } from "./errors";

// Bounds cover this whole check, not each file/subtree separately. Oversized
// evidence fails explicitly instead of silently leaving an unchecked suffix.
class ScanBudget {
  private values = 0;
  private characters = 0;
  private tokens = 0;
  private identifiers = 0;
  value() { if (++this.values > 100_000) this.fail(); }
  text(text: string) { if ((this.characters += text.length) > 16_000_000) this.fail(); }
  token() { if (++this.tokens > 250_000) this.fail(); }
  identifier() { if (++this.identifiers > 20_000) this.fail(); }
  private fail(): never {
    throw new DomainError(422, "REPAIR_INTEGRITY_LIMIT", "The copy check exceeded its bounded evidence/source scan. No candidate was cleared. Inspect the retained patch and reduce the diagnostic context with an engineer; expected answers must stay fixed.");
  }
}

// Compare complete ASCII identifiers, case-insensitively. Unicode word
// characters and underscores remain boundaries, not removable prefixes.
// Strip sentence punctuation only at the ends; interior punctuation matters.
function identifiers(text: string, budget: ScanBudget): Set<string> {
  budget.text(text);
  const found = new Set<string>();
  for (const match of text.matchAll(/[\p{L}\p{N}_./-]+/gu)) {
    const token = match[0].replace(/^[./-]+|[./-]+$/g, "");
    if (/^[A-Za-z0-9][A-Za-z0-9_./-]{6,126}[A-Za-z0-9]$/.test(token) &&
      (token.match(/[A-Za-z]/g)?.length ?? 0) >= 3 &&
      (token.match(/[0-9]/g)?.length ?? 0) >= 3) {
      const normalized = token.toUpperCase();
      if (!found.has(normalized)) { budget.identifier(); found.add(normalized); }
    }
  }
  return found;
}
function evidenceIdentifiers(value: unknown, budget: ScanBudget): Set<string> {
  const found = new Set<string>(), seen = new WeakSet<object>(), pending = [value];
  budget.value();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === "string") {
      for (const id of identifiers(next, budget)) found.add(id);
    } else if (next && typeof next === "object" && !seen.has(next)) {
      seen.add(next);
      for (const key in next) {
        if (!Object.hasOwn(next, key)) continue;
        budget.value();
        pending.push((next as Record<string, unknown>)[key]);
      }
    }
  }
  return found;
}

type Occurrence = { identifier: string; line: number; column: number };
type SyntaxNode = { type: string; start: number; [key: string]: unknown };
function runtimeIdentifiers(source: string, budget: ScanBudget): Occurrence[] | null {
  budget.text(source);
  const texts: { start: number; text: string; line: number; column: number }[] = [];
  let root: SyntaxNode;
  try {
    // Parse context disambiguates division from regular expressions. Comments,
    // binding names and unquoted property names are not runtime data.
    root = parse(source, {
      ecmaVersion: "latest", sourceType: "module", locations: true,
      allowReturnOutsideFunction: true,
      onToken(token: Token) {
        budget.token();
        // Acorn documents value, but its Token declaration omits that field.
        const value = (token as Token & { value?: unknown }).value;
        const text = token.type === tokTypes.string || token.type === tokTypes.template || token.type === tokTypes.invalidTemplate
          ? value
          : token.type === tokTypes.regexp && value && typeof value === "object" && "pattern" in value ? value.pattern : null;
        if (typeof text === "string")
          texts.push({ start: token.start, text, line: token.loc!.start.line, column: token.loc!.start.column + 1 });
      },
    }) as unknown as SyntaxNode;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    // Broken baseline files grant no exemptions. Unreadable candidates are
    // never cleared; do not expose parser excerpts containing private values.
    return null;
  }
  // String.raw uses raw template spelling, not decoded escape sequences. Other
  // tags are arbitrary computation: we inspect their literal cooked fragments.
  const rawText = new Map<number, string>(), pending = [root];
  while (pending.length) {
    budget.value();
    const node = pending.pop()!;
    if (node.type === "TaggedTemplateExpression") {
      const tag = node.tag as SyntaxNode, object = tag.object as SyntaxNode | undefined,
        property = tag.property as SyntaxNode | undefined;
      if (tag.type === "MemberExpression" && object?.type === "Identifier" && object.name === "String" &&
        (tag.computed ? property?.type === "Literal" && property.value === "raw" : property?.type === "Identifier" && property.name === "raw")) {
        for (const quasi of (node.quasi as SyntaxNode).quasis as SyntaxNode[])
          rawText.set(quasi.start, (quasi.value as { raw: string }).raw);
      }
    }
    for (const child of Object.values(node)) {
      for (const value of Array.isArray(child) ? child : [child])
        if (value && typeof value === "object" && "type" in value && typeof value.type === "string")
          pending.push(value as SyntaxNode);
    }
  }
  const found: Occurrence[] = [];
  for (const entry of texts)
    for (const identifier of identifiers(rawText.get(entry.start) ?? entry.text, budget))
      found.push({ identifier, line: entry.line, column: entry.column });
  return found;
}

export function assertRepairEvidenceIntegrity(
  candidateFiles: Record<string, string>,
  baselineFiles: Record<string, string>,
  frozenDefinition: unknown,
  evidence: unknown,
): void {
  const budget = new ScanBudget();
  const observed = evidenceIdentifiers(evidence, budget);
  if (!observed.size) return;
  // Inspect changed runtime text first. Baseline/frozen constants only matter
  // when a candidate actually contains an identifier observed in the evidence.
  // Avoid spending the shared scan budget on exemptions we never need.
  const possibleCopies: (Occurrence & { moduleIndex: number })[] = [];
  let files = 0;
  for (const file in candidateFiles) {
    if (!Object.hasOwn(candidateFiles, file) || !file.endsWith(".mjs")) continue;
    budget.value();
    const moduleIndex = ++files, source = candidateFiles[file];
    if (source === baselineFiles[file]) continue;
    const entries = runtimeIdentifiers(source, budget);
    if (!entries) throw new DomainError(422, "REPAIR_INTEGRITY_UNCHECKABLE", `Changed JavaScript module ${moduleIndex} could not be inspected. Check or simplify its syntax in the retained patch before retrying; no candidate was cleared.`);
    for (const entry of entries)
      if (observed.has(entry.identifier)) possibleCopies.push({ ...entry, moduleIndex });
  }
  if (!possibleCopies.length) return;
  const permitted = evidenceIdentifiers(frozenDefinition, budget);
  const needsExemption = () => possibleCopies.some(entry => !permitted.has(entry.identifier));
  if (!needsExemption()) return;
  for (const file in baselineFiles) {
    if (!Object.hasOwn(baselineFiles, file) || !file.endsWith(".mjs")) continue;
    budget.value();
    for (const entry of runtimeIdentifiers(baselineFiles[file], budget) ?? []) permitted.add(entry.identifier);
    if (!needsExemption()) return;
  }
  const copied = possibleCopies.find(entry => !permitted.has(entry.identifier));
  if (copied) {
    const { moduleIndex } = copied;
    throw new DomainError(
      422, "REPAIR_EVIDENCE_LEAK",
      `Changed JavaScript module ${moduleIndex}, line ${copied.line}, column ${copied.column} introduces a distinctive identifier from evaluation inputs or answers into runtime text. It is absent from frozen requirements and baseline runtime text. Inspect the retained patch and use a general rule; an intentional new constant requires an engineer decision. This check does not prove absence of other overfitting.`,
      { module_index: moduleIndex, line: copied.line, column: copied.column },
    );
  }
}
