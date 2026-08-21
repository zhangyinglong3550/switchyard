const HIGH_RISK = [
  /\bsudo\b/i,
  /\bsu\s+-/i,
  /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/i,
  /\b(?:mkfs|fdisk|diskutil|dd)\b/i,
  /\b(?:launchctl|systemctl|shutdown|reboot)\b/i,
  /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|Keychains?)(?:[\\/]|$)/i,
  /\b(?:security\s+find-|printenv|env)\b/i,
  /(?:\/etc\/|\/Library\/LaunchDaemons|System32\\)/i,
  /\b(?:curl|wget)\b.*\|\s*(?:sh|bash|zsh)\b/i
];

const LOW_RISK = [
  /^\s*(?:pwd|ls)(?:\s|$)/i,
  /^\s*(?:rg|grep|find)\b/i,
  /^\s*git\s+(?:status|diff|log|show|branch)(?:\s|$)/i,
  /^\s*(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|check|lint|typecheck))(?:\s|$)/i,
  /^\s*node\s+--test(?:\s|$)/i
];

function commandText(input = {}) {
  return String(
    input.command
    || input.toolCall?.command
    || input.toolCall?.rawInput?.command
    || input.rawInput?.command
    || ""
  ).trim();
}

function approvalDetail(input = {}, command = "") {
  const method = String(input.method || input.runtimeEvent || "");
  const reason = String(input.reason || input.message || "").trim();
  const files = Array.isArray(input.files) ? input.files : Array.isArray(input.changes) ? input.changes : [];
  const fileText = files.map((file) => typeof file === "string" ? file : file?.path || file?.filePath || "").filter(Boolean).join("\n");
  const label = command ? "将执行的命令" : fileText ? "将修改的文件" : method.includes("permissions") ? "权限请求" : "请求详情";
  const content = command || fileText || reason || "Agent 请求继续执行此操作";
  // Detail is intentionally a bounded, redacted explanation rather than raw protocol input.
  return {
    label,
    content: content
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk|sk-proj|api)[-_][A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
      .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)\s*[=:]\s*)[^\s'\"]+/g, "$1[REDACTED]")
      .slice(0, 1600)
  };
}

function optionKind(option) {
  const kind = String(option?.kind || "").trim();
  if (kind) return kind;
  const token = String(option?.optionId || option?.name || "").toLowerCase().replace(/[-\s]+/g, "_");
  if (/allow_always|always/.test(token) && !/once/.test(token)) return "allow_always";
  if (/reject_always|deny_always/.test(token)) return "reject_always";
  if (/allow/.test(token)) return "allow_once";
  if (/reject|deny/.test(token)) return "reject_once";
  return "";
}

export function classifyMobileApproval(input = {}) {
  const method = String(input.method || input.runtimeEvent || "");
  const options = Array.isArray(input.options)
    ? input.options
    : Array.isArray(input.toolCall?.options)
      ? input.toolCall.options
      : [];
  const allow = options.find((option) => optionKind(option) === "allow_once");
  const reject = options.find((option) => optionKind(option) === "reject_once");
  const command = commandText(input);
  const dangerous = HIGH_RISK.some((pattern) => pattern.test(command));
  const lowRisk = Boolean(command) && LOW_RISK.some((pattern) => pattern.test(command));
  const codexFileChange = method === "item/fileChange/requestApproval";
  // Paired mobile devices are trusted approval clients. Keep the action scoped
  // to this single request: neither ACP nor Codex receives a permanent grant.
  // Codex uses the same accept/decline reply for command, file, and permission
  // prompts, so every app-server approval can be resolved on the phone.
  const acpAllowed = Boolean(allow?.optionId && reject?.optionId);
  const codexAllowed = method.includes("requestApproval");
  const mobileAllowed = acpAllowed || codexAllowed;
  return {
    mobileAllowed,
    // Retained in the payload for backward compatibility with already-paired
    // clients. New approvals are always handled on the mobile device.
    requiresDesktop: false,
    risk: dangerous ? "high" : lowRisk ? "low" : "unknown",
    detail: approvalDetail(input, command),
    summary: codexFileChange
      ? "Codex 请求修改工作区文件"
      : dangerous
        ? "一次性执行请求"
        : lowRisk
          ? "低风险只读或验证命令"
          : mobileAllowed
            ? "一次性执行请求"
            : "当前 Agent 未提供可执行的审批选项",
    protocol: method.includes("requestApproval") ? "codex" : "acp",
    allowOptionId: acpAllowed ? String(allow.optionId) : null,
    rejectOptionId: reject?.optionId ? String(reject.optionId) : null,
    permanentOptionId: null,
    // allow_session：本会话后续同类审批自动允许（Switchyard overlay，非永久授权给 Agent）。
    actions: mobileAllowed ? ["allow_once", "allow_session", "deny_once"] : []
  };
}
