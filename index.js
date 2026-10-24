#!/usr/bin/env node
/**
 * toolknit-mcp — MCP server wrapping toolknit.com file conversion tools.
 *
 * ToolKnit runs conversions client-side in the browser (JS/WASM); files never
 * leave the machine. This server drives the tool pages in headless Microsoft
 * Edge via playwright-core: set file input -> click convert -> capture download.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { chromium } from "playwright-core";
import { convertFile, listTools, TOOL_REGISTRY } from "./lib/converter.js";

const server = new McpServer({ name: "toolknit-mcp", version: "1.0.0" });

const toolIdEnum = z.enum(Object.keys(TOOL_REGISTRY));

server.tool(
  "toolknit_list_tools",
  "List file-format conversions available on toolknit.com (tool id, accepted inputs, output format, options)",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(listTools(), null, 2),
      },
    ],
  })
);

server.tool(
  "toolknit_convert",
  "Convert a local file to another format via toolknit.com (conversion runs locally in headless Edge; the file is not uploaded anywhere). Returns the absolute path of the converted file.",
  {
    tool: toolIdEnum.describe("Tool id from toolknit_list_tools, e.g. word-to-pdf"),
    input: z
      .union([z.string(), z.array(z.string())])
      .describe("Absolute path of the file(s) to convert. Array only for multi-file tools like merge-pdf."),
    options: z
      .record(z.string())
      .optional()
      .describe("Per-tool options, e.g. {format:'png', resolution:'150'} for pdf-to-image"),
    output_dir: z
      .string()
      .optional()
      .describe("Directory for the result file. Defaults to the input file's directory."),
    timeout_sec: z.number().int().min(10).max(600).optional().describe("Conversion timeout in seconds (default 180)"),
  },
  async ({ tool, input, options, output_dir, timeout_sec }) => {
    try {
      const result = await convertFile({ toolId: tool, input, options, outputDir: output_dir, timeoutSec: timeout_sec });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, ...result }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }),
          },
        ],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("toolknit-mcp running on stdio");
