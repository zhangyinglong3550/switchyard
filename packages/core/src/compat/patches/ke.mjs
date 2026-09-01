function isKeProvider(provider) {
  if (provider?.id === "ke" || provider?.presetId === "ke") return true;
  try {
    return new URL(provider?.baseUrl || "").hostname === "openapi-ait.ke.com";
  } catch {
    return false;
  }
}

function isKeClaude(model) {
  const ids = [model?.upstreamModel, model?.id].filter(Boolean);
  // ponytail: KE 的 Claude 全系都经 Bedrock，只认 thinking.adaptive + output_config.effort；
  // 若某天 KE 直连官方 Anthropic（支持 thinking.enabled），改成按 model.reasoningEffort 判定。
  return ids.some((id) => String(id).split("/").pop().startsWith("claude-"));
}

export const kePatch = {
  id: "ke",
  label: "KE 请求适配",
  description: "给 KE 请求附带单点登录取得的系统号，并把 KE Claude 全系（Bedrock 通道）的推理字段改成 thinking.adaptive + output_config.effort。",
  trigger: "供应商标识或模板为 KE，或 Base URL 指向 openapi-ait.ke.com。",
  changes: [
    "写入供应商页通过 KE SSO 获取的 user 到请求体",
    "Claude 全系: reasoning_effort / reasoning.effort → thinking.adaptive + output_config.effort"
  ],
  risk: "仅匹配 KE；未完成 SSO 时不写 user。",
  tests: [
    "compat · KE injects the SSO system ID and adapts Claude Opus 4.8 reasoning"
  ],
  match({ provider }) {
    return isKeProvider(provider);
  },
  outbound(body, { provider, model }) {
    const out = { ...body };
    const userId = String(provider?.keUserId || "").trim();
    if (userId) out.user = userId;

    if (!isKeClaude(model)) return out;
    const effort = String(out.reasoning_effort || out.reasoning?.effort || out.output_config?.effort || "").trim();
    delete out.reasoning;
    delete out.reasoning_effort;
    delete out.thinking;
    delete out.budget_tokens;
    if (effort && !/^(none|off|disabled|false|0)$/i.test(effort)) {
      out.thinking = { type: "adaptive" };
      out.output_config = { ...(out.output_config || {}), effort };
    }
    return out;
  }
};
