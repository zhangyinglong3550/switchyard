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
  const mobileAllowed = Boolean(allow?.optionId && reject?.optionId && lowRisk && !dangerous);
  return {
    mobileAllowed,
    requiresDesktop: !mobileAllowed,
    risk: dangerous ? "high" : lowRisk ? "low" : "unknown",
    summary: dangerous
      ? "高风险操作，仅允许在桌面确认"
      : lowRisk
        ? "低风险只读或验证命令"
        : "无法确认风险，仅允许在桌面确认",
    allowOptionId: mobileAllowed ? String(allow.optionId) : null,
    rejectOptionId: reject?.optionId ? String(reject.optionId) : null,
    permanentOptionId: null,
    actions: mobileAllowed ? ["allow_once", "deny_once"] : []
  };
}
