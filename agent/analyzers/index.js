

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

export const PLANNED = {
  complexity_estimator: "week 3",
  sanitizer_run: "week 3",
  llm_review: "week 4",
  similarity_flag: "week 4",
};

export function analyzerExists(name) {
  return typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name) && name !== "index" && fs.existsSync(path.join(DIR, `${name}.js`));
}

export async function loadAnalyzer(name) {
  const mod = await import(pathToFileURL(path.join(DIR, `${name}.js`)).href);
  return mod.default;
}
