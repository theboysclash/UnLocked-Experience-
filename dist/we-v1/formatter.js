self._36e3ced9d0 = {
  prefix: "/parse/theta/",
  codec: {
    encode: url => url && (url => encodeURIComponent(url.split("").map((char, index) => (index % 16 ? String.fromCharCode(char.charCodeAt(0) ^ 16) : char)).join("")))(url),
    decode: url => { if (!url) return url; const index = url.search(/[?#]/); const value = index < 0 ? url : url.slice(0, index); const tail = index < 0 ? "" : url.slice(index); return (url => decodeURIComponent(url).split("").map((char, index) => (index % 16 ? String.fromCharCode(char.charCodeAt(0) ^ 16) : char)).join(""))(value) + tail; },
  },
  globals: {
    wrapfn: "_871cfec5$0b0a8",
    wrappropertybase: "_871cfec5$1751d",
    wrappropertyfn: "_871cfec5$2a5a9",
    cleanrestfn: "_871cfec5$3182f",
    importfn: "_871cfec5$43be6",
    rewritefn: "_871cfec5$5937d",
    metafn: "_871cfec5$6675b",
    setrealmfn: "_871cfec5$76a85",
    pushsourcemapfn: "_871cfec5$8ea32",
    trysetfn: "_871cfec5$93a59",
    templocid: "_871cfec5$abc4c",
    tempunusedid: "_871cfec5$bdbb0",
  },
  files: {
    wasm: "/spending/decoder.wasm",
    all: "/tracer/registry/f.js",
    sync: "/3/client-stream.js",
  },
  flags: {
    rewriterLogs: false,
    scramitize: false,
    cleanErrors: true,
    sourcemaps: true,
  },
};
