package com.zhangyinglong.switchyard.net

import com.zhangyinglong.switchyard.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Switchyard Session-Core daemon 的 HTTP 客户端。
 * baseUrl 形如 https://<tailscale-host>.ts.net:17889（daemon 经 tailscale serve 暴露）。
 */
class ApiClient(
    private val client: OkHttpClient = defaultClient()
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    var baseUrl: String = ""
        private set
    var token: String = ""
        private set

    private val _events = MutableSharedFlow<String>(extraBufferCapacity = 64)
    val events: SharedFlow<String> = _events

    fun configure(baseUrl: String, token: String) {
        this.baseUrl = baseUrl.trimEnd('/')
        this.token = token
    }

    private fun headers() = Headers.Builder()
        .add("Authorization", "Bearer $token")
        .add("Accept", "application/json")
        .build()

    private inline fun <reified T> parse(body: String): T = json.decodeFromString(body)

    private suspend fun <T> requestWithTimeout(
        method: String,
        path: String,
        body: String? = null,
        needAuth: Boolean = true,
        timeoutMs: Long = 30_000,
        parseFn: (String) -> T
    ): T = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(baseUrl + path)
        if (needAuth && token.isNotEmpty()) builder.headers(headers())
        if (body != null) builder.method(method, body.toRequestBody(jsonMedia)) else builder.method(method, null)
        val call = client.newCall(builder.build())
        call.timeout().timeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        call.execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}: $text")
            parseFn(text)
        }
    }

    private suspend fun <T> request(
        method: String,
        path: String,
        body: String? = null,
        needAuth: Boolean = true,
        parseFn: (String) -> T
    ): T = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(baseUrl + path)
        if (needAuth && token.isNotEmpty()) builder.headers(headers())
        if (body != null) builder.method(method, body.toRequestBody(jsonMedia)) else builder.method(method, null)
        client.newCall(builder.build()).execute().use { resp ->
            val text = resp.body?.string() ?: ""
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}: $text")
            parseFn(text)
        }
    }

    /** 健康探测（无需 token），用于配对前确认 daemon 可达 */
    suspend fun probe(): Boolean = withContext(Dispatchers.IO) {
        try {
            val resp = client.newCall(
                Request.Builder().url("$baseUrl/mobile/v1/status").build()
            ).execute()
            resp.use { it.isSuccessful }
        } catch (_: Exception) { false }
    }

    /** 配对：begin 创建 challenge，complete 用 secret 换 token */
    suspend fun pairBegin(name: String, ttlMs: Long = 600000): PairBegin =
        request("POST", "/mobile/pair/begin", """{"ttlMs":$ttlMs,"name":"${esc(name)}"}""", needAuth = false) {
            parse<PairBegin>(it)
        }

    suspend fun pairComplete(challenge: String, name: String): PairComplete =
        request("POST", "/mobile/pair/complete", """{"challenge":"${esc(challenge)}","name":"${esc(name)}"}""", needAuth = false) {
            parse<PairComplete>(it)
        }

    suspend fun agents(): List<AgentInfo> =
        request("GET", "/mobile/v1/agents") { parse<List<AgentInfo>>(it) }

    /** 当前 Agent 可用模型列表 */
    suspend fun getModels(agent: String): List<ModelInfo> =
        request("GET", "/mobile/v1/models?agent=${java.net.URLEncoder.encode(agent, "UTF-8")}") { parse<List<ModelInfo>>(it) }

    /** 当前 Agent 命令列表 */
    suspend fun getCommands(agent: String, cwd: String = "", sessionId: String = ""): List<CommandInfo> {
        val params = mutableListOf("agent=${java.net.URLEncoder.encode(agent, "UTF-8")}")
        if (cwd.isNotBlank()) params += "cwd=${java.net.URLEncoder.encode(cwd, "UTF-8")}"
        if (sessionId.isNotBlank()) params += "session=${java.net.URLEncoder.encode(sessionId, "UTF-8")}"
        return request("GET", "/mobile/v1/commands?${params.joinToString("&")}") { parse<List<CommandInfo>>(it) }
    }

    /** 切换会话模型（下一轮生效） */
    suspend fun setModel(sessionId: String, modelId: String): Boolean =
        request("POST", "/mobile/v1/sessions/$sessionId/model", """{"model":"${esc(modelId)}"}""") {
            !it.contains("\"error\"")
        }

    suspend fun sessions(agent: String? = null): List<SessionSummary> {
        val path = if (agent.isNullOrBlank() || agent == "all") "/mobile/v1/sessions" else "/mobile/v1/sessions?agent=$agent"
        return request("GET", path) { parse<List<SessionSummary>>(it) }
    }

    /** 新建会话（POST /mobile/v1/sessions）。带 model 时用短超时：grok/codex 的
     *  ACP createSession 不接受 model 参数，可能挂起而非报错，短超时让调用方 fallback。 */
    suspend fun createSession(
        agent: String,
        prompt: String,
        model: String = "",
        effort: String = "",
        permissionMode: String = "",
        cwd: String = "",
        attachments: List<Attachment> = emptyList()
    ): SessionDetail {
        val payload = buildString {
            append("""{"agent":"${esc(agent)}"""")
            if (prompt.isNotBlank()) append(""","prompt":"${esc(prompt)}"""")
            if (model.isNotBlank()) append(""","model":"${esc(model)}"""")
            if (effort.isNotBlank()) append(""","effort":"${esc(effort)}"""")
            if (permissionMode.isNotBlank()) append(""","permissionMode":"${esc(permissionMode)}"""")
            if (cwd.isNotBlank()) append(""","cwd":"${esc(cwd)}"""")
            if (attachments.isNotEmpty()) {
                append(""","attachments":[""")
                append(attachments.joinToString(",") { it.toJson() })
                append("]")
            }
            append("}")
        }
        return requestWithTimeout("POST", "/mobile/v1/sessions", payload, timeoutMs = if (model.isNotBlank()) 12_000 else 30_000) {
            // daemon 对无效参数返回 200 + {"error":...}，需显式抛错让调用方 fallback
            if (it.contains("\"error\"")) throw IOException("创建失败: ${it.take(120)}")
            parse<SessionDetail>(it)
        }
    }

    suspend fun sessionDetail(id: String, messages: Int = 100): SessionDetail =
        request("GET", "/mobile/v1/sessions/$id?messages=$messages") { parse<SessionDetail>(it) }

    suspend fun sendMessage(sessionId: String, text: String, attachments: List<Attachment> = emptyList()): SendResult {
        val payload = buildString {
            append("""{"text":"${esc(text)}"""")
            if (attachments.isNotEmpty()) {
                append(""","attachments":[""")
                append(attachments.joinToString(",") { it.toJson() })
                append("]")
            }
            append("}")
        }
        return request("POST", "/mobile/v1/sessions/$sessionId/messages", payload) {
            if (it.contains("\"error\"")) throw IOException("发送失败: ${it.take(120)}")
            parse<SendResult>(it)
        }
    }

    /** 审批决策：daemon 端点是 POST /approvals/{id}/resolve，body {decision} */
    suspend fun decideApproval(approvalId: String, decision: String, reason: String = ""): Boolean =
        request("POST", "/mobile/v1/approvals/$approvalId/resolve", """{"decision":"$decision"}""") {
            !it.contains("\"error\"")
        }

    /** SSE 事件流：保持连接，逐行抛到 events flow。 */
    fun subscribeEvents(dispatcher: okhttp3.Dispatcher = client.dispatcher) {
        val req = Request.Builder()
            .url("$baseUrl/mobile/v1/events")
            .headers(headers())
            .build()
        val call = client.newCall(req)
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                // 断线后 3s 重连（P4 保活）
                _events.tryEmit("""{"type":"conn","status":"lost"}""")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { resp ->
                    if (!resp.isSuccessful) {
                        _events.tryEmit("""{"type":"conn","status":"http_${resp.code}"}""")
                        return
                    }
                    try {
                        resp.body?.source()?.let { source ->
                            while (!source.exhausted()) {
                                val line = source.readUtf8Line() ?: break
                                if (line.startsWith("data:")) {
                                    val payload = line.removePrefix("data:").trim()
                                    if (payload.isNotEmpty()) _events.tryEmit(payload)
                                }
                            }
                        }
                    } catch (_: IOException) {
                        // 连接中断：交由 onFailure 或下一次重连处理
                        _events.tryEmit("""{"type":"conn","status":"stream_closed"}""")
                    }
                }
            }
        })
    }

    private fun esc(s: String): String =
        s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
