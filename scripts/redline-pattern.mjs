// Loads the private redline pattern for local and CI runs (tests, evals): the REDLINE_PATTERN
// environment variable (a repository secret in CI), else the gitignored .redline-pattern file.
// Returns "" when neither is set. Production reads the same secret from the Worker env.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function loadRedlinePattern(root) {
  if (process.env.REDLINE_PATTERN) return process.env.REDLINE_PATTERN.trim();
  const file = join(root, ".redline-pattern");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}
