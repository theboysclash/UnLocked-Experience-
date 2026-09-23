export const PROVIDERS = ["openrouter", "openai", "anthropic", "ollama"];

export const DEFAULT_CONFIG = {
  providers: {
    openrouter: {
      enabled: true,
      defaultModel: "anthropic/claude-3.5-sonnet",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    openai: {
      enabled: false,
      defaultModel: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    },
    anthropic: {
      enabled: false,
      defaultModel: "claude-3-5-sonnet-latest",
      baseUrl: "https://api.anthropic.com",
    },
    ollama: {
      enabled: false,
      defaultModel: "llama3.2",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
  },
  activeProvider: "openrouter",
  theme: "dark",
  fontSize: 14,
  agent: {
    maxIterations: 10,
    autoApprove: false,
    allowWebFetch: true,
    allowJavaScript: false,
    maxTokens: 4096,
  },
};

export const MODEL_SUGGESTIONS = {
  openrouter: [
    "anthropic/claude-3.5-sonnet",
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash-001",
  ],
  openai: ["gpt-4o-mini", "gpt-4o"],
  anthropic: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  ollama: ["llama3.2", "qwen2.5-coder"],
};

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function sanitizeConfig(raw) {
  const config = structuredClone(DEFAULT_CONFIG);
  if (!raw || typeof raw !== "object") return config;
  if (PROVIDERS.includes(raw.activeProvider)) config.activeProvider = raw.activeProvider;
  if (raw.theme === "light" || raw.theme === "dark") config.theme = raw.theme;
  config.fontSize = clamp(raw.fontSize, 11, 24, config.fontSize);
  const agent = raw.agent && typeof raw.agent === "object" ? raw.agent : {};
  config.agent.maxIterations = clamp(agent.maxIterations, 1, 25, config.agent.maxIterations);
  config.agent.maxTokens = clamp(agent.maxTokens, 256, 32000, config.agent.maxTokens);
  config.agent.autoApprove = Boolean(agent.autoApprove);
  config.agent.allowWebFetch = agent.allowWebFetch !== false;
  config.agent.allowJavaScript = Boolean(agent.allowJavaScript);
  const providers = raw.providers && typeof raw.providers === "object" ? raw.providers : {};
  for (const name of PROVIDERS) {
    const incoming = providers[name];
    if (!incoming || typeof incoming !== "object") continue;
    if (typeof incoming.defaultModel === "string" && incoming.defaultModel.trim()) {
      config.providers[name].defaultModel = incoming.defaultModel.trim().slice(0, 160);
    }
    if (typeof incoming.baseUrl === "string" && incoming.baseUrl.trim()) {
      config.providers[name].baseUrl = incoming.baseUrl.trim().slice(0, 300);
    }
    if (typeof incoming.enabled === "boolean") config.providers[name].enabled = incoming.enabled;
  }
  return config;
}
