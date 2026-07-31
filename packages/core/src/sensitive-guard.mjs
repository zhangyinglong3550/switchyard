/**
 * 出站敏感信息守卫：脱敏后发送，支持自定义规则/词表/白名单/按客户端/会话放行。
 */

import {
  clearSensitiveBypass as clearBypass,
  isSensitiveBypassActive,
  listSensitiveBypasses,
  allowSensitiveBypass
} from "./sensitive-bypass.mjs";

const PLACEHOLDER = (type) => `[REDACTED_${String(type || "SENSITIVE").toUpperCase()}]`;

export const SENSITIVE_GUARD_CLIENTS = [
  "codex",
  "claude-code",
  "hermes",
  "opencode",
  "grok",
  "generic-openai",
  "claude-app"
];

export const DEFAULT_SENSITIVE_WHITELIST = Object.freeze({
  phones: ["13800138000", "10086", "10010", "10000"],
  emails: ["test@example.com", "user@example.com"],
  emailDomains: ["example.com", "example.org", "example.net", "test.com", "localhost"],
  substrings: ["TEST_", "示例", "fake-", "demo-", "dummy-"]
});

function luhnOk(digits) {
  const s = String(digits || "").replace(/\D/g, "");
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    let n = Number(s[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function cnIdChecksumOk(id) {
  const s = String(id || "").toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(s[i]) * weights[i];
  return codes[sum % 11] === s[17];
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 500);
}

export function normalizeSensitiveWhitelist(input = {}, { includeDefaults = false } = {}) {
  const user = {
    phones: normalizeList(input.phones),
    emails: normalizeList(input.emails).map((item) => item.toLowerCase()),
    emailDomains: normalizeList(input.emailDomains).map((item) => item.toLowerCase()),
    substrings: normalizeList(input.substrings)
  };
  if (!includeDefaults) return user;
  const base = DEFAULT_SENSITIVE_WHITELIST;
  return {
    phones: normalizeList([...(base.phones || []), ...user.phones]),
    emails: normalizeList([...(base.emails || []), ...user.emails]),
    emailDomains: normalizeList([...(base.emailDomains || []), ...user.emailDomains]),
    substrings: normalizeList([...(base.substrings || []), ...user.substrings])
  };
}

function isWhitelistedMatch(match, whitelist, { type } = {}) {
  const text = String(match || "");
  const lower = text.toLowerCase();
  if ((whitelist.substrings || []).some((item) => item && text.includes(item))) return true;
  if (type === "phone") {
    const digits = text.replace(/\D/g, "").replace(/^86/, "");
    if ((whitelist.phones || []).includes(digits) || (whitelist.phones || []).includes(text)) return true;
  }
  if (type === "email") {
    if ((whitelist.emails || []).includes(lower)) return true;
    const domain = lower.split("@")[1] || "";
    if (domain && (whitelist.emailDomains || []).includes(domain)) return true;
  }
  return false;
}

const MAX_AUDIT_VALUE_CHARS = 500;
const MAX_AUDIT_VALUES_PER_RULE = 20;

function clipAuditValue(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_AUDIT_VALUE_CHARS) return text;
  return `${text.slice(0, MAX_AUDIT_VALUE_CHARS)}…`;
}

function makeReplaceRule({ id, type, label, regex, validate }) {
  return {
    id,
    type,
    label,
    test(text, whitelist) {
      let count = 0;
      const values = [];
      const next = String(text || "").replace(regex, (match, ...args) => {
        const full = typeof match === "string" ? match : String(match);
        if (isWhitelistedMatch(full, whitelist, { type })) return full;
        if (typeof validate === "function" && !validate(full, args)) return full;
        count += 1;
        if (values.length < MAX_AUDIT_VALUES_PER_RULE) {
          const clipped = clipAuditValue(full);
          if (!values.includes(clipped)) values.push(clipped);
        }
        return PLACEHOLDER(type);
      });
      return { next, count, values };
    }
  };
}

/** @type {Array<{ id: string, type: string, label: string, test: Function }>} */
export const BUILTIN_SENSITIVE_RULES = [
  makeReplaceRule({
    id: "cn_id_card",
    type: "id_card",
    label: "身份证号",
    regex: /(?<![A-Za-z0-9])\d{17}[\dXx](?![A-Za-z0-9])/g,
    validate: (match) => cnIdChecksumOk(match)
  }),
  makeReplaceRule({
    id: "cn_mobile",
    type: "phone",
    label: "手机号",
    // 与银行卡同级边界：禁止贴字母/数字，避免 msg_/file-/hash 中误伤。
    regex: /(?<![A-Za-z0-9])(?:\+?86[-\s]?)?1[3-9]\d{9}(?![A-Za-z0-9])/g,
    validate: (match) => /^1[3-9]\d{9}$/.test(match.replace(/\D/g, "").replace(/^86/, ""))
  }),
  makeReplaceRule({
    id: "bank_card",
    type: "bank_card",
    label: "银行卡号",
    // 两侧不能贴字母：避免打码 msg_/resp_ 等十六进制 ID 中间的数字段。
    regex: /(?<![A-Za-z0-9])(?:\d[ -]?){12,18}\d(?![A-Za-z0-9])/g,
    validate: (match) => {
      if (!/^[\d -]+$/.test(match)) return false;
      const digits = match.replace(/\D/g, "");
      if (!luhnOk(digits)) return false;
      // 纯连续数字易与协议 ID / 订单号撞车：默认要求分隔符。
      if (/[ -]/.test(match)) return digits.length >= 13 && digits.length <= 19;
      return false;
    }
  }),
  makeReplaceRule({
    id: "email",
    type: "email",
    label: "邮箱",
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    validate: (match) => {
      const lower = String(match || "").toLowerCase();
      // 跳过 git@host:path 这类 VCS 地址。
      if (lower.startsWith("git@")) return false;
      if (/\.(git|local|internal|lan|home|corp)$/i.test(lower.split("@")[1] || "")) return false;
      return true;
    }
  }),
  makeReplaceRule({
    id: "openai_sk",
    type: "api_key",
    label: "API Key",
    regex: /\bsk-[A-Za-z0-9_-]{8,}\b/g
  }),
  makeReplaceRule({
    id: "aws_akia",
    type: "api_key",
    label: "云访问密钥",
    regex: /\bAKIA[0-9A-Z]{16}\b/g
  }),
  makeReplaceRule({
    id: "bearer_token",
    type: "token",
    label: "Bearer Token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi
  }),
  makeReplaceRule({
    id: "jwt",
    type: "token",
    label: "JWT",
    // 要求三段都有一定长度，降低对短 base64 片段的误伤。
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    validate: (match) => {
      const text = String(match || "");
      // data URL / 纯 base64 载荷里的 eyJ… 不在 prose 场景处理（字段级会跳过）。
      if (text.includes(";") || text.includes("/")) return false;
      return text.length >= 36 && text.length <= 4096;
    }
  }),
  makeReplaceRule({
    id: "private_ipv4",
    type: "internal_ip",
    label: "内网 IP",
    regex: /(?<![A-Za-z0-9.-])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?![A-Za-z0-9.-])/g,
    validate: (match, args) => {
      // replace 回调里无法拿全文上下文；URL 场景靠字段 skip + 下方 looksLikeUrl 保护。
      return Boolean(match);
    }
  })
];

function compilePatternRule(row, index) {
  const pattern = String(row?.pattern || "").trim();
  if (!pattern || pattern.length > 200) return null;
  let flags = String(row?.flags || "g");
  if (!flags.includes("g")) flags += "g";
  if (!/^[gimsuy]*$/.test(flags)) flags = "g";
  try {
    const regex = new RegExp(pattern, flags);
    return makeReplaceRule({
      id: String(row.id || `custom_${index + 1}`).slice(0, 64),
      type: String(row.type || "custom").slice(0, 32),
      label: String(row.label || row.id || `自定义规则 ${index + 1}`).slice(0, 80),
      regex
    });
  } catch {
    return null;
  }
}

function compileKeywordRule(keyword, index) {
  const value = String(keyword || "").trim();
  if (!value || value.length > 120) return null;
  return makeReplaceRule({
    id: `keyword_${index + 1}`,
    type: "keyword",
    label: "组织词表",
    regex: new RegExp(escapeRegExp(value), "g")
  });
}

export function normalizeSensitiveGuardConfig(input = {}) {
  const enabled = input?.enabled !== false;
  const mode = String(input?.mode || "redact").toLowerCase() === "block" ? "block" : "redact";
  const clients = {};
  for (const id of SENSITIVE_GUARD_CLIENTS) {
    if (input?.clients && Object.prototype.hasOwnProperty.call(input.clients, id)) {
      clients[id] = input.clients[id] !== false;
    } else {
      clients[id] = true;
    }
  }
  const keywords = normalizeList(input?.keywords).slice(0, 200);
  const patterns = (Array.isArray(input?.patterns) ? input.patterns : [])
    .map((row, index) => {
      const pattern = String(row?.pattern || "").trim();
      if (!pattern) return null;
      return {
        id: String(row?.id || `pattern_${index + 1}`).slice(0, 64),
        label: String(row?.label || "").slice(0, 80),
        type: String(row?.type || "custom").slice(0, 32),
        pattern: pattern.slice(0, 200),
        flags: String(row?.flags || "g").slice(0, 8)
      };
    })
    .filter(Boolean)
    .slice(0, 50);
  return {
    enabled,
    mode,
    clients,
    keywords,
    patterns,
    // 默认记录完整命中原文到本机审计日志（高敏感，文件权限 0600）。
    auditRetainOriginal: input?.auditRetainOriginal !== false,
    // 配置里只存用户追加项；内置白名单在脱敏时再合并。
    whitelist: normalizeSensitiveWhitelist(input?.whitelist || {}, { includeDefaults: false })
  };
}

export function buildSensitiveRules(config = {}) {
  const guard = normalizeSensitiveGuardConfig(config);
  const custom = [
    ...guard.keywords.map((keyword, index) => compileKeywordRule(keyword, index)).filter(Boolean),
    ...guard.patterns.map((row, index) => compilePatternRule(row, index)).filter(Boolean)
  ];
  return [...BUILTIN_SENSITIVE_RULES, ...custom];
}

export function isClientSensitiveGuardEnabled(config, clientId) {
  const guard = normalizeSensitiveGuardConfig(config);
  if (!guard.enabled) return false;
  const id = String(clientId || "").trim();
  if (!id) return true;
  if (Object.prototype.hasOwnProperty.call(guard.clients, id)) return guard.clients[id] !== false;
  return true;
}

/**
 * 对单段文本应用规则。
 */
export function redactSensitiveText(text, {
  rules,
  config,
  whitelist
} = {}) {
  const guard = normalizeSensitiveGuardConfig(config || {});
  const activeRules = rules || buildSensitiveRules(guard);
  const wl = whitelist || normalizeSensitiveWhitelist(guard.whitelist, { includeDefaults: true });
  let next = String(text ?? "");
  const hitMap = new Map();
  for (const rule of activeRules) {
    const result = rule.test(next, wl);
    next = result.next;
    if (result.count > 0) {
      mergeHits(hitMap, [{
        ruleId: rule.id,
        type: rule.type,
        label: rule.label,
        count: result.count,
        values: result.values || []
      }]);
    }
  }
  return {
    text: next,
    hits: [...hitMap.values()],
    total: [...hitMap.values()].reduce((sum, row) => sum + row.count, 0)
  };
}

function mergeHits(into, hits) {
  for (const hit of hits || []) {
    const prev = into.get(hit.ruleId) || {
      ruleId: hit.ruleId,
      type: hit.type,
      label: hit.label,
      count: 0,
      values: []
    };
    prev.count += hit.count;
    for (const value of hit.values || []) {
      if (prev.values.length >= MAX_AUDIT_VALUES_PER_RULE) break;
      const clipped = clipAuditValue(value);
      if (clipped && !prev.values.includes(clipped)) prev.values.push(clipped);
    }
    into.set(hit.ruleId, prev);
  }
}

/** 协议/会话结构字段：绝不能打码，否则上游会 400（例如 Responses input[].id）。 */
const STRUCTURAL_ID_KEYS = new Set([
  "id",
  "item_id",
  "message_id",
  "msg_id",
  "call_id",
  "tool_call_id",
  "tool_use_id",
  "function_call_id",
  "response_id",
  "previous_response_id",
  "conversation_id",
  "thread_id",
  "session_id",
  "request_id",
  "event_id",
  "output_index",
  "content_index"
]);

/** 加密/二进制/模型元数据：整值跳过，避免 JWT/IP 规则打穿。 */
const OPAQUE_VALUE_KEYS = new Set([
  "encrypted_content",
  "signature",
  "thought_signature",
  "thoughtsignature",
  "data",
  "b64_json",
  "b64json",
  "model",
  "mime_type",
  "media_type",
  "encoding",
  "name",
  "type",
  "role",
  "object",
  "status"
]);

function isStructuralIdKey(key) {
  const name = String(key || "").trim().toLowerCase();
  if (!name) return false;
  if (STRUCTURAL_ID_KEYS.has(name)) return true;
  return /(?:^|_)(id|ids)$/.test(name) && !/(user|account|customer|order|card|phone|email)_?ids?$/.test(name);
}

function isOpaqueValueKey(key) {
  const name = String(key || "").trim().toLowerCase();
  return Boolean(name) && OPAQUE_VALUE_KEYS.has(name);
}

function looksLikeProtocolId(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 220) return false;
  if (/^(msg|resp|chatcmpl|call|fc|item|rs|evt|toolu|asst|thread|run|file|cntr|vs|cmp|oai)[_-]/i.test(value)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return true;
  return false;
}

function looksLikeUrlOrDataUri(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/^(https?:\/\/|data:|file:\/\/|ftp:\/\/)/i.test(value)) return true;
  if (/^git@[A-Za-z0-9.-]+:/.test(value)) return true;
  return false;
}

function shouldSkipStringRedaction(key, text) {
  if (isStructuralIdKey(key) || isOpaqueValueKey(key)) return true;
  if (looksLikeProtocolId(text)) return true;
  if (looksLikeUrlOrDataUri(text)) return true;
  // URL / host 字段名额外保护（含内网 IP）。
  if (/^(url|uri|href|host|hostname|endpoint|base_url|baseurl|path|filepath|filename|file_name)$/i.test(String(key || ""))) {
    return true;
  }
  return false;
}

export function redactSensitiveValue(value, {
  rules,
  config,
  whitelist,
  depth = 0,
  maxDepth = 12
} = {}) {
  const guard = normalizeSensitiveGuardConfig(config || {});
  const activeRules = rules || buildSensitiveRules(guard);
  const wl = whitelist || normalizeSensitiveWhitelist(guard.whitelist, { includeDefaults: true });
  const hitMap = new Map();
  const walk = (node, level, key = "") => {
    if (level > maxDepth) return node;
    if (typeof node === "string") {
      // 结构 ID / 协议 ID / 加密载荷 / URL 原样保留。
      if (shouldSkipStringRedaction(key, node)) return node;
      const result = redactSensitiveText(node, { rules: activeRules, whitelist: wl });
      mergeHits(hitMap, result.hits);
      return result.text;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, level + 1, key));
    if (node && typeof node === "object") {
      const out = {};
      for (const [childKey, item] of Object.entries(node)) {
        out[childKey] = walk(item, level + 1, childKey);
      }
      return out;
    }
    return node;
  };
  const body = walk(value, depth);
  const hits = [...hitMap.values()];
  return {
    body,
    hits,
    total: hits.reduce((sum, row) => sum + row.count, 0)
  };
}

/**
 * 设置页规则测试箱：只预览文本，不写审计。
 */
export function previewSensitiveText(text, config = {}) {
  const result = redactSensitiveText(text, { config });
  return {
    inputChars: String(text || "").length,
    output: result.text,
    hits: result.hits,
    total: result.total,
    changed: result.total > 0,
    summary: summarizeSensitiveHits(result.hits)
  };
}

/**
 * @returns {{ body: any, hits: object[], total: number, action: string, changed: boolean, bypass?: boolean, shouldAudit?: boolean }}
 */
export function applySensitiveGuard(body, config = {}, context = {}) {
  const guard = normalizeSensitiveGuardConfig(config);
  const clientId = String(context.clientId || "").trim();
  const sessionKey = String(context.sessionKey || "").trim();

  if (!guard.enabled) {
    return { body, hits: [], total: 0, action: "skip", changed: false, shouldAudit: false };
  }

  // 先探测命中（含原文样本）；再按客户端/会话策略决定是否脱敏。
  const detected = redactSensitiveValue(body, { config: guard });
  const hits = detected.hits;
  const total = detected.total;

  if (clientId && !isClientSensitiveGuardEnabled(guard, clientId)) {
    return {
      body,
      hits,
      total,
      action: "client_disabled",
      changed: false,
      shouldAudit: total > 0
    };
  }
  if (sessionKey && isSensitiveBypassActive(clientId, sessionKey)) {
    return {
      body,
      hits,
      total,
      action: "allow",
      changed: false,
      bypass: true,
      shouldAudit: total > 0
    };
  }

  return {
    body: detected.body,
    hits,
    total,
    action: "redact",
    changed: total > 0,
    shouldAudit: total > 0
  };
}

export function summarizeSensitiveHits(hits = []) {
  return (hits || [])
    .map((hit) => `${hit.label || hit.type}×${hit.count}`)
    .join("、");
}

/** 展平命中原文，供审计 UI 展示。 */
export function flattenSensitiveHitValues(hits = []) {
  const out = [];
  for (const hit of hits || []) {
    for (const value of hit.values || []) {
      out.push({
        type: hit.type,
        label: hit.label || hit.type,
        value
      });
      if (out.length >= 50) return out;
    }
  }
  return out;
}

function collectSensitiveStrings(value, out = [], depth = 0) {
  if (depth > 12 || out.length >= 80) return out;
  if (typeof value === "string") {
    if (value) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveStrings(item, out, depth + 1);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectSensitiveStrings(item, out, depth + 1);
  }
  return out;
}

function pushUniqueSnippet(snippets, text, maxSnippets, maxChars) {
  let snippet = String(text || "").replace(/\s+/g, " ").trim();
  if (!snippet) return;
  if (snippet.length > maxChars) snippet = `${snippet.slice(0, maxChars)}…`;
  if (!snippets.includes(snippet)) snippets.push(snippet);
}

/**
 * 从实际出站 body 提取预览片段，用于证明「发给上游的已是打码后内容」。
 * - redact：截取含 [REDACTED_*] 的上下文
 * - allow / client_disabled：截取仍含命中原文的上下文（证明明文发出）
 */
export function buildSensitiveOutboundPreview(outboundBody, {
  action = "redact",
  hits = [],
  maxSnippets = 6,
  maxChars = 280,
  contextChars = 48
} = {}) {
  const snippets = [];
  const strings = collectSensitiveStrings(outboundBody);
  const redacted = action === "redact";

  if (redacted) {
    for (const text of strings) {
      if (snippets.length >= maxSnippets) break;
      if (!/\[REDACTED_[A-Z0-9_]+\]/.test(text)) continue;
      const marker = /\[REDACTED_[A-Z0-9_]+\]/g;
      let match;
      while ((match = marker.exec(text)) && snippets.length < maxSnippets) {
        const start = Math.max(0, match.index - contextChars);
        const end = Math.min(text.length, match.index + match[0].length + contextChars);
        let slice = text.slice(start, end);
        if (start > 0) slice = `…${slice}`;
        if (end < text.length) slice = `${slice}…`;
        pushUniqueSnippet(snippets, slice, maxSnippets, maxChars);
      }
    }
    return {
      kind: "redacted",
      label: "出站已打码",
      snippets
    };
  }

  const originals = flattenSensitiveHitValues(hits).map((row) => row.value).filter(Boolean);
  for (const text of strings) {
    if (snippets.length >= maxSnippets) break;
    for (const original of originals) {
      if (snippets.length >= maxSnippets) break;
      const index = text.indexOf(original);
      if (index < 0) continue;
      const start = Math.max(0, index - contextChars);
      const end = Math.min(text.length, index + original.length + contextChars);
      let slice = text.slice(start, end);
      if (start > 0) slice = `…${slice}`;
      if (end < text.length) slice = `${slice}…`;
      pushUniqueSnippet(snippets, slice, maxSnippets, maxChars);
    }
  }
  return {
    kind: "plaintext",
    label: action === "allow" ? "出站明文（会话放行）" : "出站明文（未脱敏）",
    snippets
  };
}

export {
  allowSensitiveBypass,
  clearBypass as clearSensitiveBypass,
  listSensitiveBypasses,
  isSensitiveBypassActive
};
