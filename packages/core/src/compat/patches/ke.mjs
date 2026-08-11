function isKeProvider(provider) {
  if (provider?.id === "ke" || provider?.presetId === "ke") return true;
  try {
    return new URL(provider?.baseUrl || "").hostname === "openapi-ait.ke.com";
  } catch {
    return false;
  }
}

function isOpus48(model) {
  const ids = [model?.upstreamModel, model?.id].filter(Boolean);
  return ids.some((id) => String(id).split("/").pop() === "claude-opus-4-8");
}

export const kePatch = {
  id: "ke",
  label: "KE 请求适配",
  description: "给 KE 请求附带单点登录取得的系统号，并把 Claude Opus 4.8 的推理字段改成 Bedrock 当前支持的格式。",
  trigger: "供应商标识或模板为 KE，或 Base URL 指向 openapi-ait.ke.com。",
  changes: [
    "写入供应商页通过 KE SSO 获取的 user 到请求体",
    "Claude Opus 4.8: reasoning_effort → thinking.adaptive + output_config.effort"
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

    if (!isOpus48(model)) return out;
    const effort = String(out.reasoning_effort || out.reasoning?.effort || "").trim();
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
