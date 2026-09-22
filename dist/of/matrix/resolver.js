self._c20bf38bd5 = {
  prefix: "/parse/",
  encodeUrl: url => url && (url => encodeURIComponent(url.split("").map((char, index) => (index % 21 ? String.fromCharCode(char.charCodeAt(0) ^ 21) : char)).join("")))(url),
  decodeUrl: url => { if (!url) return url; const index = url.search(/[?#]/); const value = index < 0 ? url : url.slice(0, index); const tail = index < 0 ? "" : url.slice(index); return (url => decodeURIComponent(url).split("").map((char, index) => (index % 21 ? String.fromCharCode(char.charCodeAt(0) ^ 21) : char)).join(""))(value) + tail; },
  handler: "/observer/manager.js",
  client: "/calc/index.js",
  bundle: "/deal/bridge.js",
  config: "/of/matrix/resolver.js",
  sw: "/deal/src/registry.js",
};
