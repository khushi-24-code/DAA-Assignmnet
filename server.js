
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { ROOT, relPath } from "./agent/paths.js";
import { gradeSubmission } from "./agent/coordinator.js";
import { toolVersions } from "./agent/sandbox.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8788;
const UPLOADS_DIR = path.join(ROOT, "uploads");

// Health: the toolchain, so the UI can say up front what will and won't work.
app.get("/api/health", async (req, res) => {
  const tools = await toolVersions();
  res.json({ gcc: tools.gcc, cppcheck: tools.cppcheck });
});

// One grading job at a time: runs share the machine, and the time limits
// are wall-clock, so a second job in parallel could cause false timeouts.
let busy = false;

app.post("/api/grade", async (req, res) => {
  const target = saveUploads(req.body);
  if (target.error) return res.status(400).json({ error: target.error });
  if (busy) return res.status(409).json({ error: "The grader is busy with another job — try again in a moment." });
  busy = true;
  try {
    const { report, text, files } = await gradeSubmission({ ...target, onLog: (entry) => console.log(`  [${entry.kind}] ${entry.msg}`) });
    res.json({ report, text, files: { json: relPath(files.json), txt: relPath(files.txt) } });
  } catch (e) {
    console.log(`  [error] ${e.message}`);
    res.status(400).json({ error: e.message });
  } finally {
    busy = false;
  }
});

// ---- helpers -----------------------------------------------------------------
// Uploads are kept per problem: uploads/<problem>/ holds the rules file and
// every C file graded under it (the originality check in week 4 compares a
// new upload against these).
function saveUploads(body = {}) {
  const { rulesName, rulesContent, sourceName, source } = body;
  if (typeof rulesContent !== "string" || !rulesContent.trim()) return { error: "Upload a rules file (.json)." };
  if (typeof source !== "string" || !source.trim()) return { error: "Upload a C file (.c)." };
  const clean = (name, ext, fallback) => (String(name || fallback).replace(/[^\w.-]/g, "_").replace(new RegExp(`\\${ext}$`, "i"), "") || fallback) + ext;

  let problem = "unknown";
  try { problem = String(JSON.parse(rulesContent).problem || problem); } catch { /* loadRules reports the JSON error */ }
  const dir = path.join(UPLOADS_DIR, problem.replace(/[^\w.-]/g, "_"));
  fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
  const rulesPath = path.join(dir, "rules", clean(rulesName, ".json", "rules"));
  const submissionPath = path.join(dir, clean(sourceName, ".c", "submission"));
  fs.writeFileSync(rulesPath, rulesContent);
  fs.writeFileSync(submissionPath, source);
  return { rulesPath, submissionPath };
}

app.listen(PORT, () => {
  console.log(`AutoGrader server on http://localhost:${PORT}`);
  console.log(`  open the web UI at http://localhost:5174`);
});
