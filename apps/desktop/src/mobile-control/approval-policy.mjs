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

export function classifyMobileApproval(input = {}) {
  const method = String(input.method || input.runtimeEvent || "");
  const options = Array.isArray(input.options)
    ? input.options
    : Array.isArray(input.toolCall?.options)
      ? input.toolCall.options
      : [];
  const allow = options.find((option) => option?.kind === "allow_once");
  const reject = options.find((option) => option?.kind === "reject_once");
  const command = commandText(input);
  const dangerous = HIGH_RISK.some((pattern) => pattern.test(command));
  const lowRisk = Boolean(command) && LOW_RISK.some((pattern) => pattern.test(command));
  const codexCommand = method === "item/commandExecution/requestApproval";
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
    actions: mobileAllowed ? ["allow_once", "deny_once"] : []
  };
}
