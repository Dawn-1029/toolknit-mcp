// End-to-end MCP protocol test: spawn the server over stdio, call tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import fs from "node:fs";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("index.js")],
});
const client = new Client({ name: "toolknit-mcp-test", version: "1.0.0" });
await client.connect(transport);

const CALL_OPTS = { timeout: 300000 }; // conversions can exceed the 60s SDK default

// 1. list tools
const listed = await client.callTool({ name: "toolknit_list_tools", arguments: {} }, undefined, CALL_OPTS);
const tools = JSON.parse(listed.content[0].text);
console.log(`list_tools OK: ${tools.length} tools`);

// 2. convert docx -> pdf
const docxPath = path.resolve("test/tmp/smoke.docx");
const r1 = await client.callTool(
  { name: "toolknit_convert", arguments: { tool: "word-to-pdf", input: docxPath } },
  undefined,
  CALL_OPTS
);
const res1 = JSON.parse(r1.content[0].text);
console.log("word-to-pdf OK:", res1.file, res1.bytes, "bytes");

// 3. convert that pdf -> png with options (exercises option select handling)
const r2 = await client.callTool(
  {
    name: "toolknit_convert",
    arguments: { tool: "pdf-to-image", input: res1.file, options: { format: "png", resolution: "150" } },
  },
  undefined,
  CALL_OPTS
);
const res2 = JSON.parse(r2.content[0].text);
console.log("pdf-to-image OK:", res2.file, res2.bytes, "bytes ->", res2.extracted?.length, "files extracted");

const pngPath = res2.extracted?.[0] ?? res2.file;
const pngHead = fs.readFileSync(pngPath).subarray(0, 4).toString("latin1");
if (pngHead !== "\x89PNG") throw new Error(`Output is not a PNG (header: ${pngHead})`);
console.log("PASS: MCP protocol end-to-end, both tools, valid outputs");

await client.close();
