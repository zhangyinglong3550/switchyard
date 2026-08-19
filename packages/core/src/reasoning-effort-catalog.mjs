/**
 * 思考档位能力表：逻辑档钳制 + 供应商 wire 映射 + requestEffortTrace。
 * 对内逻辑序：none < minimal < low < medium < high < xhigh < max
 * ultra 为 Codex-only，不进入 EFFORT_ORDER。
 */

export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const OFF_RE = /^(none|off|disabled|false|0)$/i;

const GROUP = {
  passthroughResponses: {
    supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    wire: {
      effortParam: "reasoning.effort",
      thinkingParam: "none",
      effortValueMode: "passthrough"
    }
  },
  chatPassthrough: {
    supportedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    wire: {
      effortParam: "reasoning_effort",
      thinkingParam: "none",
      effortValueMode: "passthrough_chat"
    }
  },
  deepseek: {
    // 客户端可传官方兼容档；wire 层再压成 low/high/max
    supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    wire: {
      effortParam: "reasoning_effort",
      thinkingParam: "thinking",
      effortValueMode: "deepseek"
    }
  },
  openrouter: {
    supportedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    wire: {
      effortParam: "reasoning.effort",
      thinkingParam: "none",
      effortValueMode: "openrouter"
    }
  },
  anthropic: {
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    wire: {
      effortParam: "output_config.effort",
      thinkingParam: "none",
      effortValueMode: "anthropic"
    }
  },
  enableThinking: {
    supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    wire: {
      effortParam: "none",
      thinkingParam: "enable_thinking",
      effortValueMode: "on_off"
    }
  },
  thinkingObject: {
    supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    wire: {
      effortParam: "none",
      thinkingParam: "thinking",
      effortValueMode: "on_off"
    }
  },
  minimax: {
    supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    wire: {
      effortParam: "none",
      thinkingParam: "reasoning_split",
      effortValueMode: "on_off"
    }
  },
  stepfun: {
    supportedEfforts: ["low", "high"],
    defaultEffort: "high",
    wire: {
      effortParam: "reasoning_effort",
      thinkingParam: "none",
      effortValueMode: "low_high"
    }
  },
  unsupported: {
    unsupported: true,
    supportedEfforts: [],
    defaultEffort: "",
    wire: {
      effortParam: "none",
      thinkingParam: "none",
      effortValueMode: "unsupported"
    }
  },
  adapter: {
    unsupported: true,
    supportedEfforts: [],
    defaultEffort: "",
    wire: {
      effortParam: "none",
      thinkingParam: "none",
      effortValueMode: "adapter"
    }
  }
};

/** presetId → group key；未列出的走 apiFormat 回退 */
const PRESET_GROUP = {
  "codex-oauth": "passthroughResponses",
  openai: "passthroughResponses",
  "codex-account-pool": "passthroughResponses",
  "sub2api-codex": "passthroughResponses",
  deepseek: "deepseek",
  openrouter: "openrouter",
  anthropic: "anthropic",
  "anthropic-oauth": "anthropic",
  "custom-anthropic": "anthropic",
  "alibaba-bailian": "enableThinking",
  siliconflow: "enableThinking",
  zai: "thinkingObject",
  "zhipu-glm": "thinkingObject",
  "kimi-coding": "thinkingObject",
  moonshot: "thinkingObject",
  "xiaomi-mimo": "thinkingObject",
  "xiaomi-mimo-token-plan": "thinkingObject",
  modelscope: "thinkingObject",
  novita: "thinkingObject",
  nvidia: "thinkingObject",
  longcat: "thinkingObject",
  minimax: "minimax",
  stepfun: "stepfun",
  xai: "chatPassthrough",
  "xai-account-pool": "chatPassthrough",
  "opencode-go": "chatPassthrough",
  groq: "chatPassthrough",
  together: "chatPassthrough",
  perplexity: "chatPassthrough",
  fireworks: "chatPassthrough",
  mistral: "chatPassthrough",
  cerebras: "chatPassthrough",
  "volcengine-ark-agentplan": "chatPassthrough",
  "doubao-seed": "chatPassthrough",
  "byteplus-ark": "chatPassthrough",
  "baidu-qianfan": "chatPassthrough",
  bailing: "chatPassthrough",
  ke: "chatPassthrough",
  "custom-openai": "chatPassthrough",
  ollama: "unsupported",
  "lm-studio": "unsupported",
  "antigravity-account-pool": "adapter"
};

export function normalizeEffortToken(value) {
  let effort = String(value || "").trim().toLowerCase();
  if (!effort) return "";
  if (effort === "extra_high" || effort === "extra-high") effort = "xhigh";
  if (OFF_RE.test(effort)) return "none";
  return effort;
}

function effortIndex(token) {
  if (token === "ultra") return EFFORT_ORDER.indexOf("max");
  const idx = EFFORT_ORDER.indexOf(token);
  return idx;
}

export function clampEffort(requested, supported, { allowUltra = false } = {}) {
  let token = normalizeEffortToken(requested);
  if (token === "ultra") {
    if (allowUltra && Array.isArray(supported) && supported.includes("ultra")) return "ultra";
    token = "max";
  }
  const list = (Array.isArray(supported) ? supported : [])
    .map((item) => normalizeEffortToken(item))
    .filter(Boolean);
  if (!token || !list.length) return token || "";
  if (list.includes(token)) return token;
  const want = effortIndex(token);
  if (want < 0) return list[list.length - 1] || token;
  let best = list[0];
  let bestDist = Infinity;
  for (const item of list) {
    const idx = effortIndex(item);
    if (idx < 0) continue;
    const dist = Math.abs(idx - want);
    if (dist < bestDist || (dist === bestDist && idx > effortIndex(best))) {
      best = item;
      bestDist = dist;
    }
  }
  return best;
}

function cloneCapability(base) {
  return {
    ...base,
    supportedEfforts: [...(base.supportedEfforts || [])],
    wire: { ...(base.wire || {}) },
    map: base.map ? { ...base.map } : undefined
  };
}

function capabilityFromExplicit(raw) {
  if (!raw || typeof raw !== "object") return null;
  const wire = raw.wire || {
    effortParam: raw.effortParam || raw.effort_param,
    thinkingParam: raw.thinkingParam || raw.thinking_param,
    effortValueMode: raw.effortValueMode || raw.effort_value_mode
  };
  if (!wire?.effortValueMode && raw.effortValueMode) wire.effortValueMode = raw.effortValueMode;
  if (!wire?.effortValueMode) {
    // 兼容旧 codexChatReasoning
    if (raw.effortParam === "reasoning_effort" || raw.effort_param === "reasoning_effort") {
      wire.effortValueMode = raw.effortValueMode || "deepseek";
    } else if (raw.effortParam === "reasoning.effort" || raw.effort_param === "reasoning.effort") {
      wire.effortValueMode = raw.effortValueMode || "openrouter";
    } else if (raw.thinkingParam || raw.thinking_param) {
      wire.effortValueMode = "on_off";
      wire.thinkingParam = raw.thinkingParam || raw.thinking_param;
      wire.effortParam = raw.effortParam || raw.effort_param || "none";
    }
  }
  if (!wire?.effortValueMode) return null;
  return {
    supportedEfforts: Array.isArray(raw.supportedEfforts)
      ? raw.supportedEfforts.map(normalizeEffortToken).filter(Boolean)
      : [...EFFORT_ORDER],
    defaultEffort: normalizeEffortToken(raw.defaultEffort || "medium"),
    wire: {
      effortParam: wire.effortParam || "reasoning_effort",
      thinkingParam: wire.thinkingParam || "none",
      effortValueMode: wire.effortValueMode
    },
    map: raw.map && typeof raw.map === "object" ? { ...raw.map } : undefined,
    supportsProMode: Boolean(raw.supportsProMode),
    unsupported: Boolean(raw.unsupported)
  };
}

function fallbackByApiFormat(apiFormat) {
  const format = String(apiFormat || "").trim().toLowerCase();
  if (format === "openai_responses") return cloneCapability(GROUP.passthroughResponses);
  if (format === "anthropic_messages") return cloneCapability(GROUP.anthropic);
  if (format === "antigravity") return cloneCapability(GROUP.adapter);
  if (format === "openai_chat") return cloneCapability(GROUP.chatPassthrough);
  return cloneCapability(GROUP.unsupported);
}

export function resolveReasoningCapability(ctx = {}) {
  const model = ctx.model || {};
  const provider = ctx.provider || {};
  const explicit = capabilityFromExplicit(
    model.reasoningEffort
      || model.reasoning_effort
      || model.codexChatReasoning
      || model.codex_chat_reasoning
      || model.meta?.reasoningEffort
      || model.meta?.codexChatReasoning
      || provider.reasoningEffort
      || provider.reasoning_effort
      || provider.codexChatReasoning
      || provider.codex_chat_reasoning
      || provider.meta?.reasoningEffort
      || provider.meta?.codexChatReasoning
  );
  if (explicit) return explicit;

  const presetId = String(provider.presetId || provider.id || "").trim();
  const groupKey = PRESET_GROUP[presetId]
    || (presetId.startsWith("antigravity") ? "adapter" : "")
    || "";
  if (groupKey && GROUP[groupKey]) return cloneCapability(GROUP[groupKey]);
  return fallbackByApiFormat(provider.apiFormat);
}

function mapDeepseekWire(effort) {
  const token = normalizeEffortToken(effort);
  if (!token || token === "none") {
    return {
      enabled: false,
      wireParam: "reasoning_effort",
      wireValue: null,
      thinking: { type: "disabled" }
    };
  }
  let wireValue = "high";
  if (token === "low" || token === "minimal") wireValue = "low";
  else if (token === "max") wireValue = "max";
  else wireValue = "high"; // medium / high / xhigh → high（官方兼容）
  return {
    enabled: true,
    wireParam: "reasoning_effort",
    wireValue,
    thinking: { type: "enabled" }
  };
}

export function mapEffortForWire(effort, wireConfig = {}) {
  const mode = String(wireConfig.effortValueMode || "passthrough").trim();
  const token = normalizeEffortToken(effort);
  const effortParam = String(wireConfig.effortParam || "reasoning_effort").trim();
  const thinkingParam = String(wireConfig.thinkingParam || "none").trim();

  if (mode === "deepseek") return mapDeepseekWire(token);

  if (mode === "unsupported" || mode === "adapter") {
    return {
      enabled: Boolean(token && token !== "none"),
      wireParam: "none",
      wireValue: null,
      thinking: null,
      noop: true,
      providerMode: mode
    };
  }

  if (mode === "on_off") {
    const enabled = Boolean(token && token !== "none");
    const out = {
      enabled,
      wireParam: thinkingParam === "none" ? "none" : thinkingParam,
      wireValue: enabled ? "on" : "off",
      thinking: null
    };
    if (thinkingParam === "thinking") out.thinking = { type: enabled ? "enabled" : "disabled" };
    return out;
  }

  if (mode === "low_high") {
    const enabled = Boolean(token && token !== "none");
    if (!enabled) {
      return { enabled: false, wireParam: effortParam, wireValue: null, thinking: null };
    }
    const wireValue = token === "minimal" || token === "low" ? "low" : "high";
    return { enabled: true, wireParam: effortParam || "reasoning_effort", wireValue, thinking: null };
  }

  if (mode === "openrouter") {
    if (!token || token === "none") {
      return { enabled: false, wireParam: "reasoning.effort", wireValue: "none", thinking: null };
    }
    let wireValue = token;
    if (token === "max") wireValue = "xhigh"; // 与旧 reasoning-options 兼容；OpenRouter 文档也接受 max，但旧行为钳到 xhigh
    if (!["xhigh", "high", "medium", "low", "minimal", "none", "max"].includes(wireValue)) wireValue = "high";
    return { enabled: true, wireParam: "reasoning.effort", wireValue, thinking: null };
  }

  if (mode === "anthropic") {
    if (!token || token === "none") {
      return { enabled: false, wireParam: "output_config.effort", wireValue: null, thinking: null };
    }
    const wireValue = ["low", "medium", "high", "xhigh", "max"].includes(token) ? token : "high";
    return { enabled: true, wireParam: "output_config.effort", wireValue, thinking: null };
  }

  if (mode === "passthrough_chat") {
    if (!token || token === "none") {
      return { enabled: false, wireParam: "reasoning_effort", wireValue: "none", thinking: null };
    }
    return { enabled: true, wireParam: "reasoning_effort", wireValue: token, thinking: null };
  }

  // passthrough (Responses)
  if (!token || token === "none") {
    return { enabled: false, wireParam: "reasoning.effort", wireValue: "none", thinking: null };
  }
  return { enabled: true, wireParam: "reasoning.effort", wireValue: token, thinking: null };
}

function extractRequested(body) {
  if (!body || typeof body !== "object") return { explicit: false, enabled: false, effort: "", summary: "" };
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null && body.reasoning_effort !== "") {
    const effort = normalizeEffortToken(body.reasoning_effort);
    return { explicit: true, enabled: effort !== "none", effort, summary: "" };
  }
  if (!Object.prototype.hasOwnProperty.call(body, "reasoning") || body.reasoning === undefined) {
    return { explicit: false, enabled: false, effort: "", summary: "" };
  }
  const reasoning = body.reasoning;
  if (reasoning == null || reasoning === false) return { explicit: true, enabled: false, effort: "none", summary: "" };
  if (typeof reasoning === "string") {
    const effort = normalizeEffortToken(reasoning);
    return { explicit: true, enabled: effort !== "none", effort, summary: "" };
  }
  if (typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = reasoning.effort !== undefined && reasoning.effort !== null && reasoning.effort !== ""
      ? normalizeEffortToken(reasoning.effort)
      : "high";
    const summary = typeof reasoning.summary === "string" ? reasoning.summary : "";
    return { explicit: true, enabled: effort !== "none", effort, summary };
  }
  if (reasoning === true) return { explicit: true, enabled: true, effort: "high", summary: "" };
  return { explicit: true, enabled: Boolean(reasoning), effort: "high", summary: "" };
}

export function buildReasoningEffortTrace({
  requested = "",
  mapped = "",
  wireParam = "",
  wireValue = null,
  clamped = false,
  clampedFrom = null,
  providerMode = ""
} = {}) {
  return {
    requested: requested || "",
    mapped: mapped || "",
    wireParam: wireParam || "",
    wireValue: wireValue == null ? null : wireValue,
    clamped: Boolean(clamped),
    clampedFrom: clampedFrom || null,
    providerMode: providerMode || ""
  };
}

function stripReasoningFields(out) {
  delete out.reasoning;
  delete out.reasoning_effort;
  return out;
}

function applyWireToBody(out, mappedWire, capability, summary) {
  const mode = capability.wire?.effortValueMode;
  const thinkingParam = String(capability.wire?.thinkingParam || "none");

  if (mappedWire.noop || mode === "unsupported" || mode === "adapter") return out;

  stripReasoningFields(out);

  if (mode === "deepseek") {
    if (mappedWire.thinking) out.thinking = mappedWire.thinking;
    if (mappedWire.enabled && mappedWire.wireValue) out.reasoning_effort = mappedWire.wireValue;
    return out;
  }

  if (mode === "on_off") {
    if (thinkingParam === "thinking") out.thinking = { type: mappedWire.enabled ? "enabled" : "disabled" };
    else if (thinkingParam === "enable_thinking") out.enable_thinking = mappedWire.enabled;
    else if (thinkingParam === "reasoning_split") out.reasoning_split = mappedWire.enabled;
    return out;
  }

  if (mode === "anthropic") {
    // chat 侧保留 reasoning，供 anthropic adapter 继续消费；同时可写 _ 标记
    if (mappedWire.enabled && mappedWire.wireValue) {
      out.reasoning = summary ? { effort: mappedWire.wireValue, summary } : { effort: mappedWire.wireValue };
    } else {
      out.reasoning = { effort: "none" };
    }
    return out;
  }

  if (mode === "passthrough_chat" || mode === "low_high") {
    if (mappedWire.enabled && mappedWire.wireValue) out.reasoning_effort = mappedWire.wireValue;
    else if (mappedWire.wireValue === "none") out.reasoning_effort = "none";
    return out;
  }

  // passthrough / openrouter → reasoning.effort
  if (mappedWire.enabled && mappedWire.wireValue) {
    out.reasoning = summary ? { effort: mappedWire.wireValue, summary } : { effort: mappedWire.wireValue };
  } else {
    out.reasoning = { effort: "none" };
  }
  return out;
}

export function applyReasoningEffortCatalog(body, ctx = {}) {
  const request = extractRequested(body);
  if (!request.explicit) {
    return { body, trace: null };
  }

  const capability = resolveReasoningCapability(ctx);
  const mode = capability.wire?.effortValueMode || "unsupported";
  const allowUltra = Boolean(ctx.allowUltra)
    || /codex/i.test(String(ctx.provider?.id || ""))
    || /codex/i.test(String(ctx.provider?.presetId || ""));

  const requested = request.effort || (request.enabled ? "high" : "none");
  let mapped = requested;
  let clamped = false;
  let clampedFrom = null;

  if (capability.unsupported || mode === "unsupported" || mode === "adapter") {
    const trace = buildReasoningEffortTrace({
      requested,
      mapped: requested,
      wireParam: "none",
      wireValue: null,
      clamped: false,
      providerMode: mode === "adapter" ? "adapter" : "unsupported"
    });
    const next = { ...body, _switchyardReasoningEffortTrace: trace };
    return { body: next, trace };
  }

  if (Array.isArray(capability.supportedEfforts) && capability.supportedEfforts.length) {
    const clampedEffort = clampEffort(requested, capability.supportedEfforts, { allowUltra });
    if (clampedEffort && clampedEffort !== requested) {
      clamped = true;
      clampedFrom = requested;
      mapped = clampedEffort;
    } else {
      mapped = clampedEffort || requested;
    }
  }

  // 自定义 map 表（逻辑档 → 上游字面）在 clamp 之后
  if (capability.map && capability.map[mapped] != null) {
    const remapped = normalizeEffortToken(capability.map[mapped]);
    if (remapped && remapped !== mapped) {
      clamped = true;
      clampedFrom = clampedFrom || mapped;
      mapped = remapped;
    }
  }

  const mappedWire = mapEffortForWire(mapped, capability.wire);
  // deepseek 等：wire 字面与逻辑档不同时，trace.mapped 跟上游字面，便于 UI「请求→上游」
  let traceMapped = mapped;
  if (
    mappedWire.enabled
    && mappedWire.wireValue != null
    && EFFORT_ORDER.includes(String(mappedWire.wireValue))
    && String(mappedWire.wireValue) !== String(mapped)
  ) {
    clamped = true;
    clampedFrom = clampedFrom || mapped;
    traceMapped = String(mappedWire.wireValue);
  }

  const out = { ...body };
  applyWireToBody(out, mappedWire, capability, request.summary);

  const trace = buildReasoningEffortTrace({
    requested,
    mapped: traceMapped,
    wireParam: mappedWire.wireParam || capability.wire?.effortParam || "",
    wireValue: mappedWire.wireValue,
    clamped,
    clampedFrom,
    providerMode: mode
  });
  out._switchyardReasoningEffortTrace = trace;
  return { body: out, trace };
}

export function listPresetReasoningGroups() {
  return { ...PRESET_GROUP };
}
