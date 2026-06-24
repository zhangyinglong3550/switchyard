export function modelIdConflict(config, draft, editId = null) {
  const id = String(draft?.id || "").trim();
  if (!id) return { ok: true };
  const existing = (config?.models || []).find((model) => model.id === id && model.id !== editId);
  if (!existing) return { ok: true };
  const suggestedId = suggestedLocalModelId(draft);
  return {
    ok: false,
    existingProviderId: existing.providerId || "",
    suggestedId,
    message: `模型 ID "${id}" 已被供应商 "${existing.providerId || "未知"}" 使用。模型 ID 必须唯一，建议改为 "${suggestedId}"；别名仍可保留 "${draft?.upstreamModel || id}"。`
  };
}

export function suggestedLocalModelId(draft) {
  const upstream = String(draft?.upstreamModel || draft?.id || "model").trim();
  const providerSlug = slugifyProvider(draft?.providerId || "provider");
  return `${providerSlug}/${upstream}`;
}

function slugifyProvider(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "provider";
}
