// Looks for secrets in the files that could be committed or shared with the reviewer.
//   npm run scan:secrets
// Prints the file, line and rule of every finding, never the secret. Exits with 1 if anything is found.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../src/tools/secret-scan.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const findings = scanRepo(repoRoot, { extra: ["docs", "AGENTS.md", "CLAUDE.md", "README.md"] });

if (findings.length === 0) {
  console.log("No secrets found in the files that could be committed or shared.");
} else {
  console.error(`Found ${findings.length} possible secret(s):`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.rule}`);
  }
  process.exitCode = 1;
}
