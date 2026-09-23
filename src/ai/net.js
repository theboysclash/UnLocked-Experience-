function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3]) >>> 0;
}

function isPrivateAddress(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = ipv4ToInt(mapped ? mapped[1] : host);
  if (v4 == null) {
    if (host.includes(":")) {
      const head = host.split(":")[0];
      if (/^f[cd]/i.test(head) || /^fe[89ab]/i.test(head)) return true;
    }
    return false;
  }
  const a = v4 >>> 24;
  const b = (v4 >>> 16) & 255;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function assertPublicHttpUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  if (isPrivateAddress(url.hostname)) throw new Error("Private and local addresses are blocked");
  return url;
}

export function combineSignals(signals, timeoutMs) {
  const list = signals.filter(Boolean);
  if (timeoutMs) list.push(AbortSignal.timeout(timeoutMs));
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
