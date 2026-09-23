import * as esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const result = await esbuild.build({
  absWorkingDir: new URL("..", import.meta.url).pathname,
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "iife",
  write: false,
  target: ["es2022"],
  legalComments: "none",
  charset: "utf8",
});

const js = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lumen</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect rx='3' width='16' height='16' fill='%2379d8ba'/%3E%3C/svg%3E" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' data: https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self' https: http:; worker-src 'self' blob: data: https://cdn.jsdelivr.net; frame-src blob: data:; base-uri 'none'; object-src 'none'" />
<style>${css}</style>
</head>
<body>
<div id="app" class="app"></div>
<div id="modal-root"></div>
<div id="toast-root"></div>
<script>${js}</script>
</body>
</html>
`;

writeFileSync(new URL("../standalone.html", import.meta.url), html);
console.log(`wrote standalone.html (${html.length} bytes)`);
