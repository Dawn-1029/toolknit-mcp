# toolknit-mcp

MCP server that converts file formats by driving [toolknit.com](https://toolknit.com/) tool pages in headless Microsoft Edge.

All conversion work runs inside the page (client-side JS/WebAssembly — PDF.js, docx-preview, JSZip, canvas codecs), so **files never leave the machine**. The server only automates the page: set the file input → click convert → capture the download.

## Tools exposed

| Tool | Purpose |
|------|---------|
| `toolknit_list_tools` | List the 13 supported conversions, accepted inputs, options |
| `toolknit_convert` | Convert a local file; returns the absolute path of the result |

Supported conversions (first version):

- `word-to-pdf` (docx → pdf), `pdf-to-word`, `image-to-pdf` (multi-file)
- `pdf-to-image` with options `format` (png/jpg/webp) and `resolution` (72/150/300)
- `merge-pdf` (multi-file), `compress-pdf`
- `jpg-to-png`, `png-to-jpg`, `jpg-to-webp`, `png-to-webp`, `webp-to-jpg`, `webp-to-png`, `heic-to-jpg`

Multi-image results arrive as ZIP and are auto-extracted next to the download (`<name>_files/`); the result JSON lists both the ZIP and the extracted files.

## Example call

```json
{
  "tool": "pdf-to-image",
  "input": "D:\\docs\\report.pdf",
  "options": { "format": "png", "resolution": "150" }
}
```

## Requirements

- Node.js ≥ 18
- Microsoft Edge (uses the system install via playwright-core; no browser download)

## Run / test

```bash
npm install
npm start          # stdio MCP server
npm test           # direct conversion smoke test (docx → pdf)
npm run test:mcp   # full MCP protocol end-to-end test
```

## Register in an MCP client (stdio)

Clone, install, and point your MCP client at the server entry:

```bash
git clone https://github.com/Dawn-1029/toolknit-mcp.git
cd toolknit-mcp
npm install
```

```json
{
  "mcpServers": {
    "toolknit": {
      "command": "node",
      "args": ["/path/to/toolknit-mcp/index.js"]
    }
  }
}
```

Windows example: `"args": ["D:\\tools\\toolknit-mcp\\index.js"]`.

## License

[MIT](LICENSE)

## Implementation notes

- Tool pages share `#file-input` but use two button naming styles (`#btn-convert`/`#convert-btn`/`#merge-btn`/`#compress-btn`); each registry entry declares its selectors.
- Some pages import their tool script only after an async dependency chain (pdf-to-image waits for PDF.js), and Edge's injected `change` event is not always delivered — the driver re-dispatches `change` until the page's ready signal appears.
- Some pages raise blocking dialogs: merge-pdf opens a merge-all-pages modal for multi-page inputs, image-to-pdf offers image optimization mid-flow. Registry `dismiss` lists are clicked automatically (never the cancel variants).
- Download controls no-op until the page's result blob exists, so the driver clicks the download control on a 1.5s cadence until the browser fires the download event. image-to-pdf builds its download anchor dynamically (`#download-buttons a[download]`).
- Output never overwrites an input: merge tools name the result after the first input, so collisions are auto-renamed (`smoke.pdf` → `smoke-1.pdf`).
- pdf-to-word latency varies from ~25s to several minutes (site-side); its default timeout is 420s. All other tools finish in under ~15s for typical files.
- On failure the server saves a debug screenshot to the OS temp dir and includes its path plus any page errors in the error message.
- Site UI changes will break selectors; the fix is usually a one-line registry update in `lib/converter.js`.
