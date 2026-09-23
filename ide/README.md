# Lumen

Lumen is a browser-native IDE: Monaco (or a plain fallback), a file tree, and a streaming agent. It is a static site. There is no account server and no installer.

Open a folder with the File System Access API in Chrome or Edge, or keep a virtual project in the browser and export a zip. Bring an API key for [OpenRouter](https://openrouter.ai), OpenAI, Anthropic, or a local Ollama server.

## Run it

From this directory:

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`. Live folder access requires a secure page (`localhost` or `https`). Importing a folder copy works in other browsers.

Build one HTML file you can open directly:

```bash
npm install
npm test
npm run build
```

`standalone.html` contains the app. Monaco still loads from the jsDelivr CDN when you are online. If that fails, Lumen edits in a plain text area. Double-clicking the file cannot use the live folder API; use a virtual project or serve the file from localhost.

## Keys

API keys stay in page memory. Settings can keep a key in `sessionStorage` for the current tab. They are not written to `localStorage`. A key leaves the browser only as the `Authorization` header (or Anthropic's `x-api-key`) on the request to the provider you chose.

OpenRouter is the reliable browser provider. Anthropic often rejects pages directly. Ollama has to be reached from `http://localhost` because an https page will not call `http://127.0.0.1`.

## Agent

The agent can list, search, read, edit, and write workspace text files. Edits wait for Apply unless you turn on auto-approve. `web_fetch` can read public `http(s)` URLs and refuses local and private addresses. Optional JavaScript runs in a sandboxed frame with no page, file, or network access, and it is off until you enable it.

The prompt button stores instructions in this browser. `{{workspace_name}}`, `{{os}}`, `{{language}}`, and `{{skills_index}}` are filled in when you send. Skills are markdown files: drop them in `.skills/<name>/SKILL.md`, paste them in Settings, or fetch a GitHub file URL.

## Shortcuts

| Key | Action |
|---|---|
| Ctrl/Cmd+S | Save the active file |
| Ctrl/Cmd+B | Explorer |
| Ctrl/Cmd+J | Agent |
| Ctrl/Cmd+, | Settings |
| Enter | Send the chat draft |
| Shift+Enter | New line in the draft |

## What the browser cannot do

Lumen cannot spawn a shell, start a process, or speak stdio to a local MCP server. File changes go through the folder you granted or through the virtual project stored in IndexedDB.
