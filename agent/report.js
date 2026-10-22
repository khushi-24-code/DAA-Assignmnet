

import fs from "node:fs";
import path from "node:path";

export function buildReport({ submission, submissionHash, rules, firstPass, metrics, grade, gradedPoints, failures, suggestions, flags, tools }) {
  return {
    submission,
    submission_hash: submissionHash,
    problem: rules.problem,
    rules_file: rules.file,
    rules_hash: rules.hash,
    grade,
    graded_points: gradedPoints,
    first_pass: firstPass,
    metrics,
    failures,
    suggestions,
    flags,
    tool_versions: tools,
  };
}

export function writeReports(report, text, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.basename(report.submission).replace(/\.c$/i, "");
  const json = path.join(outDir, `${stem}.json`);
  const txt = path.join(outDir, `${stem}.txt`);
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(txt, text);
  return { json, txt };
}

// ---- the student-facing text ------------------------------------------------
const W = 78;
const fmt = (v) => String(Math.round(v * 10) / 10);

function wrap(text, indent, first = "") {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = first;
  for (const w of words) {
    if (cur.length + w.length + 1 > W && cur.trim()) { lines.push(cur); cur = indent; }
    cur += (cur.trim() && !cur.endsWith(" ") ? " " : "") + w;
  }
  if (cur.trim()) lines.push(cur);
  return lines.join("\n");
}

function block(label, value, indent) {
  const lines = String(value === "" ? "(nothing)" : value).replace(/\n$/, "").split("\n");
  return lines.map((l, i) => (i === 0 ? `${indent}${label.padEnd(10)}${l}` : `${indent}${" ".repeat(10)}${l}`)).join("\n");
}

export function renderText(r) {
  const out = [];
  const fp = r.first_pass;
  out.push(`===== Grading report for ${r.submission} =====`);
  out.push(`Overall grade: ${r.grade.toFixed(1)} / 100   (${r.graded_points} of 100 points graded so far; the rest are pending)`);
  out.push(`Problem: ${r.problem}   Rules: ${r.rules_file} (${r.rules_hash.slice(0, 15)}...${r.rules_hash.slice(-4)})`);
  out.push(`First pass: compiled=${fp.compiled ? "yes" : "NO"}  smoke_run=${fp.smoke_ok ? "ok" : fp.smoke_status || "not run"}  suspected_infinite_loop=${fp.suspected_infinite_loop ? "YES" : "no"}`);
  out.push("");
  out.push(`${"Metric".padEnd(15)}${"Weight".padStart(6)}  ${"Score".padEnd(8)}${"Contribution".padEnd(14)}Verdict`);
  for (const m of r.metrics) {
    const w = Math.round(m.weight * 100);
    const score = m.status === "skipped" || m.status === "pending" ? "--" : `${fmt(m.contribution)}/${w}`;
    const verdict = m.status === "skipped" || m.status === "pending" ? `${m.status}: ${m.verdict}` : m.verdict;
    out.push(`${m.name.padEnd(15)}${String(w).padStart(6)}  ${score.padEnd(8)}${m.contribution.toFixed(1).padStart(6).padEnd(14)}${verdict}`);
  }

  if (r.flags.length) {
    out.push("", "--- Flags ---");
    for (const f of r.flags) out.push(wrap(`${f.type}: ${f.detail}`, "    ", "  ! "));
  }

  if (r.failures.length) {
    out.push("", "--- Where you failed ---");
    for (const f of r.failures.slice(0, 6)) {
      out.push(f.label);
      out.push(block("INPUT:", f.input, "  "));
      out.push(block("EXPECTED:", f.expected, "  "));
      out.push(block("GOT:", f.got || `(${f.note || "no output"})`, "  "));
      if (f.note && f.got) out.push(block("NOTE:", f.note, "  "));
      out.push(wrap(f.why, " ".repeat(12), "  WHY:      "));
      out.push("");
    }
    if (r.failures.length > 6) out.push(`  … ${r.failures.length - 6} more failing input(s) in the JSON report.`, "");
    else out.pop();
  }

  if (r.suggestions.length) {
    out.push("", "--- Suggestions to raise the grade ---");
    for (const s of r.suggestions) out.push(wrap(s, "  ", "- "));
  }

  return out.join("\n");
}
