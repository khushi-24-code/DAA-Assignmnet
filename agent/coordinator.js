

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadRules, sourceText, hiddenTests } from "./rules.js";
import { loadAnalyzer, PLANNED } from "./analyzers/index.js";
import { compile, run, staticBytes, toolVersions } from "./sandbox.js";
import { blank, findFunctions } from "./cparse.js";
import { ROOT } from "./paths.js";
import { buildReport, renderText, writeReports } from "./report.js";

// Calls a grading sandbox must never let a submission make.
const UNSAFE_CALLS = /\b(system|popen|_popen|fork|vfork|exec[lv]p?e?|_exec\w*|_spawn\w*|CreateProcess\w*|ShellExecute\w*|WinExec|LoadLibrary\w*|socket|connect|remove|unlink|_unlink|rename|rmdir|_rmdir)\s*\(/g;
const READERS = /\b(scanf|fscanf|getchar|fgets|gets|getline|getc|fgetc|fread|read)\s*\(/;
const WRITERS = /\b(printf|puts|putchar|fputs|fprintf|putc|fputc|fwrite|write)\s*\(/;

export async function gradeSubmission({ submissionPath, rulesPath, outDir = path.join(ROOT, "reports"), onLog }) {
  const log = (e) => onLog?.(e);
  const rules = loadRules(rulesPath);
  const source = fs.readFileSync(submissionPath, "utf8");
  const submission = path.basename(submissionPath);

  log({ kind: "plan", msg: `plan: rules → first pass (static sanity, compile, smoke run) → ${rules.metrics.length} analyzers → weighted grade → feedback → reports.` });
  log({ kind: "observe", msg: `rules ${rules.file}: "${rules.problem}", ${rules.metrics.length} metrics, limits ${rules.time_limit_s}s / ${rules.memory_limit_mb} MB, ${rules.hash.slice(0, 19)}…` });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "autograder-"));
  try {
    fs.writeFileSync(path.join(workDir, "prog.c"), source);
    const tools = await toolVersions();
    const first = await firstPass({ rules, source, workDir, log });

    const ctx = makeContext({ rules, source, workDir, log });
    if (rules.reference && first.runnable) await buildReference(rules, workDir, log);

    const results = await dispatch(rules, ctx, first, log);

    // ---- collate ---------------------------------------------------------------
    const metrics = rules.metrics.map((m, i) => {
      const r = results[i];
      const score = round(Math.min(1, Math.max(0, r.score ?? 0)), 2);
      return {
        name: m.name, analyzer: m.analyzer, weight: m.weight, status: r.status,
        score, contribution: round(score * m.weight * 100, 1),
        verdict: r.verdict, feedback: r.feedback, evidence: r.evidence ?? {},
      };
    });
    const grade = round(metrics.reduce((s, m) => s + m.contribution, 0), 1);
    const gradedPoints = round(metrics.filter((m) => m.status !== "pending").reduce((s, m) => s + m.weight * 100, 0), 1);
    log({ kind: "verdict", msg: `grade: ${grade.toFixed(1)} / 100 — weighted sum of analyzer scores, computed in code (${gradedPoints} of 100 points graded so far).` });

    const failures = collectFailures(rules, results);
    const suggestions = [...new Set(results.flatMap((r) => r.suggestions || []))].slice(0, 10);
    const flags = [...first.flags, ...results.flatMap((r) => r.flags || [])];

    const report = buildReport({
      submission,
      submissionHash: `sha256:${crypto.createHash("sha256").update(source).digest("hex")}`,
      rules,
      firstPass: first.summary,
      metrics, grade, gradedPoints, failures, suggestions, flags, tools,
    });
    const text = renderText(report);
    const files = writeReports(report, text, outDir);
    log({ kind: "done", msg: `reports written: ${path.relative(ROOT, files.json)}, ${path.relative(ROOT, files.txt)}` });
    return { report, text, files };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a killed process may still hold a file on Windows */ }
  }
}

// ---- 2. first pass ----------------------------------------------------------
async function firstPass({ rules, source, workDir, log }) {
  const flags = [];
  const code = blank(source);
  const fns = findFunctions(source);
  const main = fns.find((f) => f.name === "main");
  const mainBody = main ? code.split("\n").slice(main.startLine - 1, main.endLine).join("\n") : "";
  const unsafe = [...new Set([...code.matchAll(UNSAFE_CALLS)].map((m) => m[1]))];
  const sanity = {
    has_main: Boolean(main),
    reads_input: READERS.test(code),
    writes_output: WRITERS.test(code),
    main_returns: /\breturn\b/.test(mainBody),
    unsafe_calls: unsafe,
  };
  log({ kind: "observe", msg: `static sanity: main ${sanity.has_main ? "✓" : "✗"}, reads input ${sanity.reads_input ? "✓" : "✗"}, writes output ${sanity.writes_output ? "✓" : "✗"}, return in main ${sanity.main_returns ? "✓" : "✗"}${unsafe.length ? `, UNSAFE: ${unsafe.join(", ")}` : ""}.` });
  if (unsafe.length) flags.push({ type: "unsafe_call", detail: `calls ${unsafe.join(", ")} — the program was not executed` });

  log({ kind: "tool", msg: "compile check → gcc -O2 -Wall -Wextra -std=c11" });
  const build = await compile(workDir, { out: "prog.exe", flags: ["-O2", "-Wall", "-Wextra", "-std=c11"] });
  const warnings = build.diagnostics.filter((d) => d.kind === "warning").length;
  if (!build.ok) {
    const err = build.diagnostics.find((d) => d.kind === "error");
    log({ kind: "error", msg: `compile failed${err ? `: line ${err.line}: ${err.message}` : ""}` });
    flags.push({ type: "compile_error", detail: err ? `line ${err.line}: ${err.message}` : build.stderr.slice(0, 200) });
  } else {
    log({ kind: "observe", msg: `compiled with ${warnings} warning(s).` });
  }

  let smoke = null, staticMem = 0, skipReason = null;
  const exe = path.join(workDir, "prog.exe");
  if (!build.ok) skipReason = "does not compile";
  else if (unsafe.length) skipReason = `unsafe call (${unsafe.join(", ")}) — not executed`;
  else {
    // Measure the student's static data only: subtract an empty program
    // built the same way (the C runtime's own data lives there too).
    fs.writeFileSync(path.join(workDir, "baseline.c"), "int main(void) { return 0; }\n");
    await compile(workDir, { source: "baseline.c", out: "baseline.exe", flags: ["-O2", "-std=c11"] });
    staticMem = Math.max(0, (await staticBytes(exe)) - (await staticBytes(path.join(workDir, "baseline.exe"))));
    if (staticMem > rules.memory_limit_mb * 1024 * 1024) {
      skipReason = `static data ${(staticMem / 1048576).toFixed(1)} MB exceeds the ${rules.memory_limit_mb} MB limit`;
      flags.push({ type: "exceeds_memory_limit", detail: skipReason });
      log({ kind: "error", msg: skipReason });
    } else {
      const input = hiddenTests(rules)[0]?.input ?? "";
      log({ kind: "tool", msg: `smoke run → first hidden test under ${rules.time_limit_s}s` });
      smoke = await run(exe, { input, timeLimitS: rules.time_limit_s, cwd: workDir });
      log({ kind: smoke.status === "ok" ? "observe" : "error", msg: `smoke run: ${smoke.status}${smoke.crash ? ` (${smoke.crash})` : ""} in ${smoke.timeMs.toFixed(0)} ms.` });
      if (smoke.status === "timeout" || smoke.status === "output_limit") {
        skipReason = "smoke run did not halt (suspected infinite loop)";
        flags.push({ type: "suspected_infinite_loop", detail: `the first hidden test did not finish within ${rules.time_limit_s}s${smoke.status === "output_limit" ? " (endless output)" : ""}` });
      } else if (smoke.status === "crash") {
        flags.push({ type: "smoke_crash", detail: `crashed on the first hidden test: ${smoke.crash}` });
      }
    }
  }

  return {
    runnable: !skipReason,
    skipReason,
    flags,
    summary: {
      compiled: build.ok,
      compile_warnings: warnings,
      smoke_ok: smoke?.status === "ok",
      smoke_status: smoke?.status ?? null,
      suspected_infinite_loop: flags.some((f) => f.type === "suspected_infinite_loop"),
      static_data_bytes: staticMem,
      static_sanity: sanity,
      execution_skipped: skipReason,
    },
  };
}

async function buildReference(rules, workDir, log) {
  fs.writeFileSync(path.join(workDir, "ref.c"), sourceText(rules.reference));
  const res = await compile(workDir, { source: "ref.c", out: "ref.exe", flags: ["-O2", "-std=c11"] });
  if (!res.ok) {
    const err = res.diagnostics.find((d) => d.kind === "error");
    const where = err ? `line ${err.line} of "reference": ${err.message}` : res.stderr.slice(0, 300);
    throw new Error(`the reference solution in the rules file does not compile — ${where}. (Inside JSON, a C "\\n" must be written as "\\\\n".)`);
  }
  log({ kind: "tool", msg: "reference solution (from the rules file) built" });
}

// What every analyzer receives. Runs are memoized per input: the same input
// fed to the same binary gives the same result, so analyzers can share them.
function makeContext({ rules, source, workDir, log }) {
  const memo = { student: new Map(), reference: new Map() };
  const runner = (which, exe, timeFactor) => (input) => {
    if (!memo[which].has(input)) {
      memo[which].set(input, run(path.join(workDir, exe), { input, cwd: workDir, timeLimitS: rules.time_limit_s * timeFactor }));
    }
    return memo[which].get(input);
  };
  return {
    rules, source, workDir, log,
    seed: rules.seed,
    timeLimitS: rules.time_limit_s,
    memoryLimitMb: rules.memory_limit_mb,
    runStudent: runner("student", "prog.exe", 1),
    runReference: runner("reference", "ref.exe", 3),
  };
}

// ---- 3. dispatch --------------------------------------------------------------
async function dispatch(rules, ctx, first, log) {
  const analyzers = await Promise.all(rules.metrics.map((m) => (PLANNED[m.analyzer] ? null : loadAnalyzer(m.analyzer))));
  const results = new Array(rules.metrics.length);

  const runOne = async (i) => {
    const m = rules.metrics[i], a = analyzers[i];
    if (!a) {
      log({ kind: "skip", msg: `pending ${m.analyzer} ("${m.name}") — not implemented yet (${PLANNED[m.analyzer]}).` });
      results[i] = { status: "pending", score: 0, verdict: `not implemented yet (${PLANNED[m.analyzer]})`, feedback: `The ${m.analyzer} analyzer is planned for ${PLANNED[m.analyzer]}; this metric scores 0 until then.`, evidence: {} };
      return;
    }
    if (a.kind === "execution" && !first.runnable) {
      log({ kind: "skip", msg: `skip ${m.analyzer} ("${m.name}") — ${first.skipReason}.` });
      results[i] = { status: "skipped", score: 0, verdict: first.skipReason, feedback: `Not run: ${first.skipReason}.`, evidence: {} };
      return;
    }
    const missing = (a.requires || []).filter((k) => !rules[k]);
    if (missing.length) {
      results[i] = { status: "error", score: 0, verdict: "rules incomplete", feedback: `The rules file needs ${missing.join(" and ")} for the ${m.analyzer} analyzer.`, evidence: {} };
      log({ kind: "error", msg: `${m.analyzer}: rules file lacks ${missing.join(", ")}.` });
      return;
    }
    log({ kind: "tool", msg: `dispatch → ${m.analyzer} for "${m.name}" (weight ${m.weight}, params ${JSON.stringify(m.params)})` });
    try {
      results[i] = { status: "ok", ...(await a.run({ ...ctx, metric: m }, m.params)) };
    } catch (e) {
      log({ kind: "error", msg: `${m.analyzer} failed: ${e.message}` });
      results[i] = { status: "error", score: 0, verdict: "analyzer error", feedback: `The ${m.analyzer} analyzer could not run: ${e.message}`, evidence: { error: e.message } };
    }
  };

  // Execution analyzers first, ONE AT A TIME: each one enforces a wall-clock
  // time limit, and running them alongside anything CPU-heavy (another run,
  // cppcheck) could push a correct program into a spurious timeout — a grade
  // that depended on scheduling would not be reproducible. The source-only
  // analyzers then run side by side.
  const order = rules.metrics.map((_, i) => i);
  for (const i of order.filter((i) => analyzers[i]?.kind === "execution")) await runOne(i);
  await Promise.all(order.filter((i) => analyzers[i]?.kind !== "execution").map(runOne));
  return results;
}

// ---- 4. counter-examples -----------------------------------------------------
// Failing inputs from every analyzer, one entry per distinct input, in metric
// order.
function collectFailures(rules, results) {
  const seen = new Set();
  const out = [];
  rules.metrics.forEach((m, i) => {
    for (const f of results[i].failures || []) {
      if (seen.has(f.input_id)) continue;
      seen.add(f.input_id);
      out.push({ metric: m.name, ...f });
    }
  });
  return out;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
