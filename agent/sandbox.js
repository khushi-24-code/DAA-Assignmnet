

import { spawn } from "node:child_process";
import path from "node:path";

export const TOOLS = {
  cc: process.env.CC || "gcc",
  cppcheck: process.env.CPPCHECK || "cppcheck",
  size: "size",
};

const OUTPUT_CAP = 1 << 20;           // 1 MB of stdout is far more than any test needs
const STACK_BYTES = 8 * 1024 * 1024;  // same as the Linux default

// Windows reports a crash as an NTSTATUS exit code, Linux as a signal.
const CRASH_CODES = {
  3221225477: "access violation (invalid memory read or write)", // 0xC0000005
  3221225725: "stack overflow",                                  // 0xC00000FD
  3221225501: "illegal instruction (sanitizer trap)",            // 0xC000001D
  3221225620: "integer divide by zero",                          // 0xC0000094
  3221226505: "stack buffer overrun detected",                   // 0xC0000409
  3221226356: "heap corruption",                                 // 0xC0000374
};
const CRASH_SIGNALS = {
  SIGSEGV: CRASH_CODES[3221225477],
  SIGBUS: CRASH_CODES[3221225477],
  SIGILL: CRASH_CODES[3221225501],
  SIGFPE: "arithmetic error (e.g. divide by zero)",
  SIGABRT: "abort() called",
};

// ---- tool runner -----------------------------------------------------------
// For trusted tools (gcc, cppcheck, size). Never used for student code.
export function exec(cmd, args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "";
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true }); }
    catch (e) { return resolve({ code: -1, stdout, stderr: e.message, missing: true }); }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message, missing: e.code === "ENOENT" }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ---- compile ---------------------------------------------------------------
// Builds one binary (or, with objectOnly, one object file) inside the work
// dir. Returns gcc's diagnostics already parsed.
export async function compile(workDir, { source = "prog.c", out, flags = [], objectOnly = false }) {
  const args = [...flags];
  if (objectOnly) args.push("-c", source, "-o", out);
  else {
    args.push(source, "-o", out);
    if (process.platform === "win32") args.push(`-Wl,--stack,${STACK_BYTES}`);
    args.push("-lm");
  }
  const res = await exec(TOOLS.cc, args, { cwd: workDir });
  if (res.missing) throw new Error(`C compiler "${TOOLS.cc}" not found — install gcc and put it on PATH (or set CC in .env).`);
  return { ok: res.code === 0, stderr: res.stderr, diagnostics: parseDiagnostics(res.stderr, source) };
}

// gcc "file:line:col: kind: message [-Wflag]" → structured records, keeping
// only diagnostics about the submission itself.
export function parseDiagnostics(stderr, source = "prog.c") {
  const out = [];
  const re = /^(.*?):(\d+):(\d+): (fatal error|error|warning): (.*?)(?: \[([^\]]+)\])?\s*$/gm;
  let m;
  while ((m = re.exec(stderr))) {
    if (path.basename(m[1]) !== source) continue;
    out.push({ line: Number(m[2]), col: Number(m[3]), kind: m[4] === "warning" ? "warning" : "error", message: m[5], flag: m[6] || null });
  }
  return out;
}

// Static data (globals, big static arrays) is reserved before main() runs.
// `size` reads it from the binary, so it can be checked before any run.
export async function staticBytes(exe) {
  const res = await exec(TOOLS.size, [exe]);
  const m = res.stdout.split("\n")[1]?.trim().split(/\s+/);
  return m ? Number(m[1]) + Number(m[2]) : 0;
}

// ---- run -------------------------------------------------------------------
// The one way student code is executed. Minimal environment, its own working
// directory, stdin from `input`, and every limit enforced.
export function run(exe, { input = "", timeLimitS, cwd }) {
  return new Promise((resolve) => {
    const env = {
      PATH: process.env.PATH || "",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
    };

    let stdout = "", stderr = "", killedFor = null;
    const t0 = process.hrtime.bigint();
    const child = spawn(exe, [], { cwd, env, windowsHide: true });
    const kill = (why) => { if (!killedFor) { killedFor = why; child.kill("SIGKILL"); } };
    const timer = setTimeout(() => kill("timeout"), timeLimitS * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > OUTPUT_CAP) { stdout = stdout.slice(0, OUTPUT_CAP); kill("output_limit"); }
    });
    child.stderr.on("data", (d) => { if (stderr.length < 65536) stderr += d; });
    child.stdin.on("error", () => { /* program exited before reading all input */ });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: "crash", crash: `could not start: ${e.message}`, exitCode: null, stdout, stderr, timeMs: 0 });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const timeMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const base = { exitCode: code, stdout, stderr, timeMs };
      if (killedFor) return resolve({ ...base, status: killedFor });
      const crash = (signal && (CRASH_SIGNALS[signal] || `killed by ${signal}`)) || CRASH_CODES[code];
      if (crash) return resolve({ ...base, status: "crash", crash });
      resolve({ ...base, status: "ok" });
    });
    child.stdin.end(input);
  });
}

// ---- tool versions ---------------------------------------------------------
// Recorded in every report: "same rules" only means "same grade" on the same
// toolchain, so the report says which toolchain that was.
export async function toolVersions() {
  const first = (s) => (s || "").split("\n")[0].trim();
  const [gcc, cppcheck] = await Promise.all([
    exec(TOOLS.cc, ["-dumpfullversion"]),
    exec(TOOLS.cppcheck, ["--version"]),
  ]);
  return {
    gcc: gcc.code === 0 ? first(gcc.stdout) : null,
    cppcheck: cppcheck.code === 0 ? first(cppcheck.stdout).replace(/^Cppcheck\s*/i, "") : null,
    node: process.versions.node,
    platform: process.platform,
  };
}
