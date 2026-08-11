package com.zhangyinglong.switchyard.data

import kotlinx.serialization.Serializable

/** 4 类 Agent + 全部面板 */
enum class AgentId(val slug: String, val label: String, val short: String) {
    ALL("all", "全部", "✦"),
    GROK("grok", "Grok", "G"),
    CODEX("codex", "Codex", "C"),
    CLAUDE("claude-code", "Claude", "C"),
    OPENCODE("opencode", "OpenCode", "O");

    companion object {
        fun fromSlug(slug: String?): AgentId =
            entries.firstOrNull { it.slug == slug } ?: ALL
    }
}

@Serializable
data class AgentInfo(
    val id: String = "",
    val label: String = "",
    val name: String = "",
    val available: Boolean = false,
    val version: String = "",
    val capabilities: kotlinx.serialization.json.JsonElement? = null
)

@Serializable
data class SessionSummary(
    val id: String = "",
    val agent: String = "",
    val agentId: String = "",
    val agentLabel: String = "",
    val title: String = "",
    val preview: String = "",
    val state: String = "completed",
    val updatedAt: String = "",
    val fileCount: Int = 0,
    val project: String = "",
    val directory: String = ""
) {
    /** daemon 返回字段是 agent（如 "grok"），agentId 是冗余别名，优先用 agent */
    val resolvedAgent: AgentId get() = AgentId.fromSlug(if (agent.isNotBlank()) agent else agentId)
    val isRunning: Boolean get() = state == "running"
    val needsApproval: Boolean get() = state == "awaiting_approval" || state == "needs_approval" || state == "approval"
    val isFailed: Boolean get() = state == "failed" || state == "error"
}

@Serializable
data class SessionMessage(
    val seq: Int = 0,
    val role: String = "assistant",
    val kind: String = "text",
    val text: String = "",
    val ts: Long = 0,
    val turn: String = "",
    val tool: ToolCall? = null,
    val toolJson: String? = null
) {
    val isUser: Boolean get() = role == "user"
    val isTool: Boolean get() = kind == "tool" || tool != null || !toolJson.isNullOrBlank()
}

@Serializable
data class ToolCall(
    val id: String = "",
    val name: String = "",
    val title: String = "",
    val status: String = "",
    val content: String = ""
)

@Serializable
data class SessionDetail(
    val id: String = "",
    val title: String = "",
    val agent: String = "",
    val agentId: String = "",
    val state: String = "completed",
    val model: String = "",
    val nativeId: String = "",
    val directory: String = "",
    val messages: List<SessionMessage> = emptyList(),
    val pendingApprovals: List<ApprovalItem> = emptyList()
) {
    val resolvedAgent: AgentId get() = AgentId.fromSlug(if (agent.isNotBlank()) agent else agentId)
}

/** diff 审批项 */
@Serializable
data class ApprovalItem(
    val id: String = "",
    val type: String = "edit",
    val summary: String = "",
    val file: String = "",
    val additions: Int = 0,
    val deletions: Int = 0,
    val diff: String = "",
    val metadata: String = "",
    val requiresDesktop: Boolean = false,
    val commandLine: String = "",
    val options: List<ApprovalOption> = emptyList()
)

/** 审批选项（对齐 daemon approval.options） */
@Serializable
data class ApprovalOption(
    val kind: String = "",      // allow_once | allow_session | deny_once | ...
    val label: String = ""
)

@Serializable
data class SendResult(
    val accepted: Boolean = false,
    val duplicate: Boolean = false,
    val state: String = "",
    val queued: Boolean = false
)

@Serializable
data class ApprovalDecision(
    val action: String = "allow_once",
    val reason: String = ""
)

@Serializable
data class PairBegin(
    val secret: String = "",
    val pairingPath: String = ""
)

@Serializable
data class PairComplete(
    val token: String = "",
    val id: String = "",
    val name: String = ""
)

/** 模型信息（daemon GET /mobile/v1/models） */
@Serializable
data class ModelInfo(
    val id: String = "",
    val name: String = "",
    val provider: String = "",
    val contextWindow: Long? = null,
    val capabilities: kotlinx.serialization.json.JsonElement? = null
)

/** 命令信息（daemon GET /mobile/v1/commands） */
@Serializable
data class CommandInfo(
    val id: String = "",
    val kind: String = "",
    val name: String = "",
    val description: String = "",
    val insertText: String = ""
)

/** 发送消息附件（图片/文件），对齐 daemon sendMessage 的 attachments 契约 */
data class Attachment(
    val kind: String = "text",          // image | text | file
    val name: String = "",
    val data: String = "",              // base64（image 用）
    val mimeType: String = "",
    val text: String = "",              // text 附件内容
    val path: String = ""
) {
    fun toJson(): String = buildString {
        append("{")
        append("\"kind\":\"$kind\"")
        if (name.isNotBlank()) append(",\"name\":\"${esc(name)}\"")
        if (data.isNotBlank()) append(",\"data\":\"$data\"")
        if (mimeType.isNotBlank()) append(",\"mimeType\":\"$mimeType\"")
        if (text.isNotBlank()) append(",\"text\":\"${esc(text)}\"")
        if (path.isNotBlank()) append(",\"path\":\"${esc(path)}\"")
        append("}")
    }
    private fun esc(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
}
