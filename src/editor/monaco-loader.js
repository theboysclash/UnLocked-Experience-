const VERSION = "0.52.2";
const BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${VERSION}/min/vs`;

export function loadMonaco() {
  if (globalThis.monaco?.editor) return Promise.resolve(globalThis.monaco);
  if (globalThis.__lumenMonaco) return globalThis.__lumenMonaco;
  globalThis.__lumenMonaco = new Promise((resolve, reject) => {
    globalThis.MonacoEnvironment = {
      getWorkerUrl() {
        const source = [
          `self.MonacoEnvironment={baseUrl:${JSON.stringify(`https://cdn.jsdelivr.net/npm/monaco-editor@${VERSION}/min/`)}};`,
          `importScripts(${JSON.stringify(`${BASE}/base/worker/workerMain.js`)});`,
        ].join("");
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
      },
    };
    const script = document.createElement("script");
    script.src = `${BASE}/loader.js`;
    script.async = true;
    script.onload = () => {
      try {
        globalThis.require.config({ paths: { vs: BASE } });
        globalThis.require(["vs/editor/editor.main"], () => resolve(globalThis.monaco), reject);
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error("Monaco failed to load"));
    document.head.append(script);
  });
  return globalThis.__lumenMonaco;
}
