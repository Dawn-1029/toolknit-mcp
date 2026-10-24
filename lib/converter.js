/**
 * Core driver: runs a toolknit.com tool page in headless Edge and captures the
 * converted download. All conversion work happens in the page itself (local
 * JS/WASM) — no file bytes are sent to any server.
 *
 * Tool pages share the #file-input element but split into two naming styles
 * for action buttons; each registry entry declares its own selectors. On every
 * page the download action no-ops until the page's result blob exists, so the
 * driver clicks the download control on a cadence until the download fires.
 */
import { chromium } from "playwright-core";
import { unzipSync } from "fflate";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const BASE = "https://toolknit.com/tools";

const DEFAULT_SELECTORS = { convert: "#btn-convert", download: "#btn-download" };
const CONVERTBTN_SELECTORS = { convert: "#convert-btn", download: "#download-all-btn" };

const TOOL_REGISTRY = {
  "word-to-pdf": { title: "Word → PDF", accept: [".docx"], out: ".pdf", multi: false, options: {} },
  "pdf-to-word": {
    title: "PDF → Word",
    accept: [".pdf"],
    out: ".docx",
    multi: false,
    // This tool's latency varies wildly (25s to >3min observed on the same
    // file — the site mentions a shared usage limit), so give it more room.
    defaultTimeoutSec: 420,
    options: {},
  },
  "pdf-to-image": {
    title: "PDF → Image",
    accept: [".pdf"],
    out: ".png",
    multi: false,
    selectors: CONVERTBTN_SELECTORS,
    zip: true,
    options: {
      format: { selector: "#format-select", values: ["png", "jpg", "webp"] },
      resolution: { selector: "#resolution-select", values: ["72", "150", "300"] },
    },
  },
  "image-to-pdf": {
    title: "Image → PDF",
    accept: [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"],
    out: ".pdf",
    multi: true,
    selectors: {
      convert: "#convert-btn",
      // Download buttons are created dynamically after conversion; the PDF one
      // is an anchor with a download attribute inside #download-buttons.
      download: "#download-buttons a[download]",
    },
    // The page offers an image-optimization dialog mid-flow; skip it to keep originals.
    dismiss: ["#resize-skip"],
    options: {},
  },
  "merge-pdf": {
    title: "Merge PDFs",
    accept: [".pdf"],
    out: ".pdf",
    multi: true,
    selectors: { convert: "#merge-btn", download: "#download-btn" },
    // #merge-btn can be enabled before any file lands; the file list showing
    // up is the reliable "input accepted" signal for this page.
    ready: "#add-more-btn",
    // With any multi-page input the page opens a modal (merge all / select
    // pages / cancel). "Merge all" is the faithful default; NEVER click cancel.
    dismiss: ["#mp-all"],
    options: {},
  },
  "compress-pdf": {
    title: "Compress PDF",
    accept: [".pdf"],
    out: ".pdf",
    multi: false,
    selectors: { convert: "#compress-btn", download: "#download-btn" },
    options: {},
  },
  "jpg-to-png": { title: "JPG → PNG", accept: [".jpg", ".jpeg"], out: ".png", multi: false, selectors: CONVERTBTN_SELECTORS, zip: true, options: {} },
  "png-to-jpg": { title: "PNG → JPG", accept: [".png"], out: ".jpg", multi: false, selectors: CONVERTBTN_SELECTORS, zip: true, options: {} },
  "jpg-to-webp": { title: "JPG → WebP", accept: [".jpg", ".jpeg"], out: ".webp", multi: false, selectors: CONVERTBTN_SELECTORS, zip: true, options: {} },
  "png-to-webp": { title: "PNG → WebP", accept: [".png"], out: ".webp", multi: false, selectors: CONVERTBTN_SELECTORS, zip: true, options: {} },
  "webp-to-jpg": { title: "WebP → JPG", accept: [".webp"], out: ".jpg", multi: false, selectors: CONVERTBTN_SELECTORS, zip: true, options: {} },
  "webp-to-png": { title: "WebP → PNG", accept: [".webp"], out: ".png", multi: false, selectors: CONVERTBTN_SELECTORS, zip: true, options: {} },
  "heic-to-jpg": { title: "HEIC → JPG", accept: [".heic", ".heif"], out: ".jpg", multi: false, selectors: CONVERTBTN_SELECTORS, zip: true, options: {} },
};

const MAX_INPUT_BYTES = 200 * 1024 * 1024; // WASM tools choke well before this

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findEdge() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

async function launchEdge() {
  // Prefer playwright's registry-based channel resolution, fall back to known paths.
  try {
    return await chromium.launch({ channel: "msedge", headless: true });
  } catch {
    const exe = findEdge();
    if (!exe) throw new Error("Microsoft Edge not found — install Edge or adjust EDGE_CANDIDATES");
    return await chromium.launch({ executablePath: exe, headless: true });
  }
}

function selectorsOf(toolId) {
  return { ...DEFAULT_SELECTORS, ...(TOOL_REGISTRY[toolId].selectors || {}) };
}

export function listTools() {
  return Object.entries(TOOL_REGISTRY).map(([id, t]) => ({
    id,
    title: t.title,
    accepts: t.accept.join(", "),
    output: t.out.replace(".", ""),
    multi_file: t.multi,
    options: Object.fromEntries(
      Object.entries(t.options).map(([k, v]) => [k, { allowed: v.values }])
    ),
  }));
}

function resolveInputs(toolId, input) {
  const t = TOOL_REGISTRY[toolId];
  const files = Array.isArray(input) ? input : [input];
  if (files.length > 1 && !t.multi) throw new Error(`Tool ${toolId} accepts a single file`);
  if (files.length < 1) throw new Error("No input file given");
  for (const f of files) {
    if (!path.isAbsolute(f)) throw new Error(`Input path must be absolute: ${f}`);
    if (!fs.existsSync(f)) throw new Error(`Input file not found: ${f}`);
    const st = fs.statSync(f);
    if (!st.isFile()) throw new Error(`Not a file: ${f}`);
    if (st.size > MAX_INPUT_BYTES) throw new Error(`Input too large (>200MB): ${f}`);
    const ext = path.extname(f).toLowerCase();
    if (t.accept.length && !t.accept.includes(ext)) {
      throw new Error(`Tool ${toolId} accepts ${t.accept.join(", ")}, got ${ext || "no extension"}`);
    }
  }
  return files;
}

function extractZip(zipPath, outDir) {
  const data = fs.readFileSync(zipPath);
  const files = unzipSync(data);
  const dir = outDir;
  fs.mkdirSync(dir, { recursive: true });
  const extracted = [];
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    // Defensive: strip any path traversal.
    const safe = path.basename(name);
    const target = path.join(dir, safe);
    fs.writeFileSync(target, content);
    extracted.push(target);
  }
  return extracted.sort();
}

export async function convertFile({ toolId, input, options = {}, outputDir, timeoutSec }) {
  const t = TOOL_REGISTRY[toolId];
  if (!t) throw new Error(`Unknown tool: ${toolId}. Call toolknit_list_tools for valid ids.`);
  timeoutSec = timeoutSec || t.defaultTimeoutSec || 180;
  const files = resolveInputs(toolId, input);

  const outDir = outputDir ? path.resolve(outputDir) : path.dirname(files[0]);
  fs.mkdirSync(outDir, { recursive: true });

  const sel = selectorsOf(toolId);

  const browser = await launchEdge();
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutSec * 1000);
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await page.goto(`${BASE}/${toolId}.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("#file-input", { state: "attached" });

    await page.setInputFiles("#file-input", files);

    // Some pages attach their change listener only after an async module chain
    // (e.g. pdf-to-image imports PDF.js before importing its own tool script),
    // so a change event fired right after load can go unheard. The files stay
    // on the input — re-dispatch change until the page acknowledges them.
    // Acknowledged = ready signal visible AND no known blocking dialog open
    // (e.g. merge-pdf's merge-all-pages modal, image-to-pdf's optimize offer).
    const dismissSelectors = t.dismiss || [];
    const reactDeadline = Date.now() + 30000;
    for (;;) {
      for (const s of dismissSelectors) {
        try {
          await page.click(s, { timeout: 1200 });
        } catch {
          /* dialog not open — nothing to dismiss */
        }
      }
      const ready = await page.evaluate(
        ({ readySel, convertSel, dismissSels }) => {
          const vis = (sel) => {
            const el = document.querySelector(sel);
            return !!el && el.offsetParent !== null;
          };
          let ok;
          if (readySel) {
            ok = vis(readySel);
          } else {
            const el = document.querySelector(convertSel);
            ok = !!el && el.offsetParent !== null && !el.disabled;
          }
          return ok && !dismissSels.some(vis);
        },
        { readySel: t.ready || null, convertSel: sel.convert, dismissSels: dismissSelectors }
      );
      if (ready) break;
      if (Date.now() > reactDeadline) {
        throw new Error("Page never reacted to the input file (tool script may have failed to load)");
      }
      await page.evaluate(() => {
        document.getElementById("file-input").dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(300);
    }

    for (const [key, value] of Object.entries(options)) {
      const opt = t.options[key];
      if (!opt) throw new Error(`Tool ${toolId} has no option '${key}'`);
      if (!opt.values.includes(String(value))) {
        throw new Error(`Option '${key}' allows ${opt.values.join(", ")}, got '${value}'`);
      }
      // Option controls can live in panels that stay hidden until interaction;
      // fall back to setting the value directly and notifying listeners.
      try {
        await page.selectOption(opt.selector, String(value), { timeout: 3000 });
      } catch {
        await page.waitForSelector(opt.selector, { state: "attached", timeout: 10000 });
        await page.evaluate(
          ({ s, v }) => {
            const el = document.querySelector(s);
            el.value = v;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          },
          { s: opt.selector, v: String(value) }
        );
      }
    }

    await page.waitForSelector(sel.convert, { state: "visible" });
    await page.click(sel.convert);

    const downloadPromise = page.waitForEvent("download", { timeout: timeoutSec * 1000 });
    let stopped = false;
    // Controls to nudge on a cadence: the download button (no-ops until the
    // result blob exists) plus any mid-flow dialogs the tool insists on
    // (e.g. image-to-pdf's optimize-images offer).
    const nudgeSelectors = [sel.download, ...(t.dismiss || [])].filter(Boolean);
    const clickLoop = (async () => {
      if (!nudgeSelectors.length) return;
      while (!stopped) {
        for (const s of nudgeSelectors) {
          if (stopped) break;
          try {
            await page.click(s, { timeout: 1500 });
          } catch {
            /* not ready or not present yet — keep trying until the timeout */
          }
        }
        if (!stopped) await page.waitForTimeout(1500);
      }
    })();

    let download;
    try {
      download = await downloadPromise;
    } catch (err) {
      const shot = path.join(os.tmpdir(), `toolknit-debug-${Date.now()}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      throw new Error(
        `No download produced by ${toolId}. Debug screenshot: ${shot}` +
          (pageErrors.length ? ` Page errors: ${pageErrors.join(" | ")}` : "")
      );
    } finally {
      stopped = true;
      await clickLoop.catch(() => {});
    }

    const suggested = download.suggestedFilename() || `converted${t.out}`;
    // Never overwrite an input file: merge tools name the output after the
    // first input ("smoke.pdf" -> "smoke.pdf"), which would clobber it.
    let outPath = path.join(outDir, suggested);
    const inputSet = new Set(files.map((f) => path.resolve(f)));
    if (inputSet.has(path.resolve(outPath))) {
      const ext = path.extname(suggested);
      const stem = ext ? suggested.slice(0, -ext.length) : suggested;
      for (let n = 1; inputSet.has(path.resolve(outPath)); n++) {
        outPath = path.join(outDir, `${stem}-${n}${ext}`);
      }
    }
    await download.saveAs(outPath);

    const bytes = fs.statSync(outPath).size;
    if (bytes === 0) throw new Error("Downloaded file is empty — conversion may have failed");

    const result = { tool: toolId, file: outPath, filename: suggested, bytes };

    if (suggested.toLowerCase().endsWith(".zip")) {
      const extractDir = path.join(outDir, suggested.replace(/\.zip$/i, "") + "_files");
      result.extracted = extractZip(outPath, extractDir);
    }

    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

export { TOOL_REGISTRY };
