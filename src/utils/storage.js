import { sanitizeConfig } from "../config.js";

const CONFIG_KEY = "lumen.config";
const SESSION_KEY = "lumen.keys";
const memoryKeys = Object.create(null);

function sessionStore() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function localStore() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadConfig() {
  const store = localStore();
  if (!store) return sanitizeConfig(null);
  try {
    const raw = store.getItem(CONFIG_KEY);
    return sanitizeConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeConfig(null);
  }
}

export function saveConfig(config) {
  const store = localStore();
  if (!store) return;
  const clean = sanitizeConfig(config);
  store.setItem(CONFIG_KEY, JSON.stringify(clean));
}

export function getKey(provider) {
  return memoryKeys[provider] || "";
}

export function setKey(provider, key, { persistSession = false } = {}) {
  const value = String(key || "").trim();
  if (value) memoryKeys[provider] = value;
  else delete memoryKeys[provider];
  const session = sessionStore();
  if (!session) return;
  const saved = readSessionKeys();
  if (persistSession && value) saved[provider] = value;
  else delete saved[provider];
  if (Object.keys(saved).length) session.setItem(SESSION_KEY, JSON.stringify(saved));
  else session.removeItem(SESSION_KEY);
}

export function sessionKeyEnabled(provider) {
  return Boolean(readSessionKeys()[provider]);
}

export function loadSessionKeys() {
  const saved = readSessionKeys();
  for (const [provider, key] of Object.entries(saved)) {
    if (typeof key === "string" && key) memoryKeys[provider] = key;
  }
}

function readSessionKeys() {
  const session = sessionStore();
  if (!session) return {};
  try {
    const raw = JSON.parse(session.getItem(SESSION_KEY) || "{}");
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [provider, key] of Object.entries(raw)) {
      if (typeof key === "string") out[provider] = key;
    }
    return out;
  } catch {
    return {};
  }
}
