// Smoke test: generate a small docx, convert it via toolknit word-to-pdf.
import { Document, Packer, Paragraph, TextRun } from "docx";
import * as fs from "node:fs";
import * as path from "node:path";
import { convertFile, listTools } from "../lib/converter.js";

const dir = path.resolve("test/tmp");
fs.mkdirSync(dir, { recursive: true });

const doc = new Document({
  sections: [
    {
      children: [
        new Paragraph({ children: [new TextRun({ text: "ToolKnit MCP smoke test", bold: true, size: 32 })] }),
        new Paragraph({ children: [new TextRun({ text: "中文段落测试：自荐信转换验证。", size: 24 })] }),
      ],
    },
  ],
});

const docxPath = path.join(dir, "smoke.docx");
fs.writeFileSync(docxPath, await Packer.toBuffer(doc));
console.log("generated:", docxPath, fs.statSync(docxPath).size, "bytes");

console.log("tools registry:", listTools().length, "tools");

const t0 = Date.now();
const result = await convertFile({ toolId: "word-to-pdf", input: docxPath });
console.log("convert result:", JSON.stringify(result, null, 2));
console.log("elapsed:", ((Date.now() - t0) / 1000).toFixed(1), "s");

const head = fs.readFileSync(result.file).subarray(0, 5).toString("latin1");
if (head !== "%PDF-") throw new Error(`Output is not a PDF (header: ${head})`);
console.log("PASS: output is a valid PDF");
