// Full-catalog test: exercise every registered tool (except heic-to-jpg, which
// needs a HEIC source file this machine does not have) and verify output magic.
import path from "node:path";
import fs from "node:fs";
import { convertFile } from "../lib/converter.js";

const dir = path.resolve("test/tmp");
const pdf = path.join(dir, "smoke.pdf");
const png = path.join(dir, "smoke-images_files", "smoke_page_01.png");

const MAGIC = {
  pdf: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  png: (b) => b.subarray(0, 4).toString("latin1") === "\x89PNG",
  jpg: (b) => b.subarray(0, 3).toString("latin1") === "\xff\xd8\xff",
  webp: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  docx: (b) => b.subarray(0, 2).toString("latin1") === "PK",
};

const results = [];

function pick(r, ext) {
  const cands = [r.file, ...(r.extracted || [])];
  return cands.find((f) => f.toLowerCase().endsWith(ext)) || cands[0];
}

async function run(id, input, ext, kind, options) {
  const t0 = Date.now();
  try {
    const r = await convertFile({ toolId: id, input, options });
    const target = pick(r, ext);
    const okMagic = MAGIC[kind](fs.readFileSync(target));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ tool: id, status: okMagic ? "PASS" : `BAD-MAGIC(${kind})`, secs, file: path.basename(target) });
    console.log(`${okMagic ? "PASS" : "FAIL"} ${id} (${secs}s) -> ${path.basename(target)}`);
    return target;
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ tool: id, status: "ERROR: " + e.message.slice(0, 120), secs });
    console.log(`FAIL ${id} (${secs}s): ${e.message.slice(0, 200)}`);
    return null;
  }
}

// Chain image formats so each test feeds the next.
const jpg1 = await run("png-to-jpg", png, ".jpg", "jpg");
const webp1 = await run("png-to-webp", png, ".webp", "webp");
if (jpg1) await run("jpg-to-png", jpg1, ".png", "png");
if (jpg1) await run("jpg-to-webp", jpg1, ".webp", "webp");
if (webp1) await run("webp-to-jpg", webp1, ".jpg", "jpg");
if (webp1) await run("webp-to-png", webp1, ".png", "png");

// Multi-file tools (distinct files — pages dedupe repeated filenames).
const pngAgain = jpg1 ? path.join(dir, "smoke_page_01_converted.png") : png;
if (jpg1 && fs.existsSync(pngAgain)) await run("image-to-pdf", [pngAgain, jpg1], ".pdf", "pdf");
const compressed = path.join(dir, "smoke_compressed.pdf");
await run("merge-pdf", fs.existsSync(compressed) ? [pdf, compressed] : [pdf, pdf], ".pdf", "pdf");

// Single pdf tools.
await run("compress-pdf", pdf, ".pdf", "pdf");
await run("pdf-to-word", pdf, ".docx", "docx");

const failed = results.filter((r) => r.status !== "PASS");
console.log("\n==== SUMMARY ====");
for (const r of results) console.log(`${r.status.padEnd(20)} ${r.tool} (${r.secs}s)`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
