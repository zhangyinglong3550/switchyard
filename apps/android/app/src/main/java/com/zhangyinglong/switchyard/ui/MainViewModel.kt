package com.zhangyinglong.switchyard.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.zhangyinglong.switchyard.data.*
import com.zhangyinglong.switchyard.net.ApiClient
import com.zhangyinglong.switchyard.security.TokenStore
import com.zhangyinglong.switchyard.ui.theme.AppTheme
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class UiState(
    val theme: AppTheme = AppTheme.LIGHT,
    val baseUrl: String = "",
    val paired: Boolean = false,
    val connecting: Boolean = false,
    val error: String? = null,
    val agents: List<AgentInfo> = emptyList(),
    val allSessions: List<SessionSummary> = emptyList(),
    val currentPanel: AgentId = AgentId.ALL,
    val selectedSession: SessionDetail? = null,
    val showDetail: Boolean = false,
    val sending: Boolean = false,
    // 模型 / 命令
    val models: List<ModelInfo> = emptyList(),
    val commands: List<CommandInfo> = emptyList(),
    val modelSheetVisible: Boolean = false,
    val currentModel: String = "",
    // 图片附件
    val pendingImages: List<Attachment> = emptyList(),
    // 新建会话
    val newSessionDialogVisible: Boolean = false
)

class MainViewModel(
    private val api: ApiClient,
    private val store: TokenStore
) : ViewModel() {

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()
    private val cache = SessionCache(store.context)

    private var refreshJob: Job? = null

    init {
        val savedUrl = store.loadBaseUrl()
        val savedToken = store.loadToken()
        if (!savedUrl.isNullOrBlank() && !savedToken.isNullOrBlank()) {
            api.configure(savedUrl, savedToken)
            _state.value = _state.value.copy(baseUrl = savedUrl, paired = true)
            refresh()
        }
    }

    /** 设置 daemon 地址并同步到 ApiClient */
    fun setBaseUrl(url: String) {
        val clean = url.trimEnd('/')
        api.configure(clean, store.loadToken() ?: "")
        _state.value = _state.value.copy(baseUrl = clean, error = null)
    }

    /** 配对：begin → complete → 保存 token */
    fun pair(name: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(connecting = true, error = null)
            try {
                api.configure(_state.value.baseUrl, store.loadToken() ?: "")
                val ch = api.pairBegin(name)
                val done = api.pairComplete(ch.secret, name)
                // 立即更新 ApiClient 的 token（否则 refresh 用空 token 拉不到会话）
                api.configure(_state.value.baseUrl, done.token)
                store.saveToken(done.token)
                store.saveBaseUrl(_state.value.baseUrl)
                store.saveDeviceName(name)
                _state.value = _state.value.copy(paired = true, connecting = false)
                refresh()
            } catch (e: Exception) {
                _state.value = _state.value.copy(connecting = false, error = e.message ?: "配对失败")
            }
        }
    }

    /** 拉取 agents + 会话列表（失败时回退离线缓存） */
    fun refresh() {
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch {
            try {
                val agents = api.agents()
                val sessions = api.sessions()
                cache.saveSessions(sessions)
                _state.value = _state.value.copy(agents = agents, allSessions = sessions, error = null)
            } catch (e: Exception) {
                val cached = cache.loadSessions()
                if (cached.isNotEmpty()) {
                    _state.value = _state.value.copy(allSessions = cached, error = "离线模式（显示缓存）")
                } else {
                    _state.value = _state.value.copy(error = e.message ?: "刷新失败")
                }
            }
        }
    }

    fun switchPanel(agent: AgentId) {
        _state.value = _state.value.copy(currentPanel = agent)
    }

    fun openSession(id: String) {
        viewModelScope.launch {
            try {
                val detail = api.sessionDetail(id)
                cache.saveDetail(id, detail)
                _state.value = _state.value.copy(selectedSession = detail, showDetail = true, error = null)
                // 加载该 Agent 的命令列表（供 / 命令拾取器）
                loadCommands(detail.resolvedAgent.slug, detail.directory, detail.id)
            } catch (e: Exception) {
                val cached = cache.loadDetail(id)
                if (cached != null) {
                    _state.value = _state.value.copy(selectedSession = cached, showDetail = true, error = "离线模式（显示缓存）")
                } else {
                    _state.value = _state.value.copy(error = e.message ?: "打开会话失败")
                }
            }
        }
    }

    fun closeDetail() {
        _state.value = _state.value.copy(showDetail = false, selectedSession = null)
    }

    fun sendMessage(text: String) {
        val session = _state.value.selectedSession ?: return
        val attachments = _state.value.pendingImages
        viewModelScope.launch {
            _state.value = _state.value.copy(sending = true)
            try {
                api.sendMessage(session.id, text, attachments)
                // 乐观更新：立即把 user 消息追加到本地，用户立刻看到"已发送"
                val optimisticMsg = SessionMessage(
                    seq = session.messages.size,
                    role = "user",
                    kind = "text",
                    text = text,
                    ts = System.currentTimeMillis()
                )
                val optimisticSession = session.copy(messages = session.messages + optimisticMsg)
                _state.value = _state.value.copy(sending = false, pendingImages = emptyList(), selectedSession = optimisticSession)
                // 后台刷新详情拉 agent 回复：与乐观消息合并（本地 user 消息优先保留）
                try {
                    val detail = api.sessionDetail(session.id)
                    // 合并：服务器消息 + 本地乐观 user 消息（去重）
                    val merged = mergeMessages(detail, optimisticMsg)
                    _state.value = _state.value.copy(selectedSession = merged)
                } catch (_: Exception) {
                    // 刷新失败保留乐观视图
                }
            } catch (e: Exception) {
                _state.value = _state.value.copy(sending = false, error = e.message ?: "发送失败")
            }
        }
    }

    /** 合并服务器详情与本地乐观消息（避免刷新覆盖刚发的消息） */
    private fun mergeMessages(detail: SessionDetail, optimistic: SessionMessage): SessionDetail {
        val serverTexts = detail.messages.map { it.text }.toSet()
        val hasOptimistic = serverTexts.contains(optimistic.text)
        return if (hasOptimistic) detail
        else detail.copy(messages = detail.messages + optimistic)
    }

    /** 添加图片附件（base64 data） */
    fun addImage(name: String, base64Data: String, mimeType: String) {
        val current = _state.value.pendingImages
        if (current.size >= 4) return // 最多 4 张
        _state.value = _state.value.copy(
            pendingImages = current + Attachment(kind = "image", name = name, data = base64Data, mimeType = mimeType)
        )
    }

    fun removeImage(index: Int) {
        val current = _state.value.pendingImages.toMutableList()
        if (index in current.indices) {
            current.removeAt(index)
            _state.value = _state.value.copy(pendingImages = current)
        }
    }

    /** 打开新建会话对话框：拉取模型列表供选择；当前为"全部"时自动选第一个可用 Agent */
    fun openNewSessionDialog() {
        var agent = _state.value.currentPanel
        if (agent == AgentId.ALL) {
            // 自动选第一个可用 Agent：优先 agents 列表，空则用固定顺序兜底
            val first = _state.value.agents.firstOrNull()?.let { AgentId.fromSlug(it.id) }
            agent = when {
                first != null && first != AgentId.ALL -> first
                else -> AgentId.GROK
            }
        }
        _state.value = _state.value.copy(currentPanel = agent)
        viewModelScope.launch {
            try {
                val models = api.getModels(agent.slug)
                _state.value = _state.value.copy(models = models, newSessionDialogVisible = true, error = null)
            } catch (e: Exception) {
                _state.value = _state.value.copy(newSessionDialogVisible = true, error = "模型列表加载失败，将使用默认")
            }
        }
    }

    fun closeNewSessionDialog() {
        _state.value = _state.value.copy(newSessionDialogVisible = false)
    }

    /** 新建会话：模型 + 思考模式 + 首条消息。模型失败时自动 fallback（grok runtime 不接受 model 参数） */
    fun createSession(prompt: String, model: String = "", effort: String = "") {
        val agent = _state.value.currentPanel
        if (agent == AgentId.ALL) {
            _state.value = _state.value.copy(error = "请先从抽屉选择一个 Agent")
            return
        }
        viewModelScope.launch {
            _state.value = _state.value.copy(sending = true, newSessionDialogVisible = false)
            try {
                var created: SessionDetail? = null
                try {
                    created = api.createSession(agent.slug, prompt, model = model, effort = effort)
                } catch (e: Exception) {
                    // model 不被 runtime 接受时 fallback 到默认模型重试
                    created = api.createSession(agent.slug, prompt)
                }
                if (created == null) throw IllegalStateException("会话创建失败")
                // 乐观更新：把首条消息加入新会话
                val optimisticMsg = SessionMessage(
                    seq = 0, role = "user", kind = "text", text = prompt, ts = System.currentTimeMillis()
                )
                val sessionWithMsg = created.copy(messages = created.messages + optimisticMsg)
                _state.value = _state.value.copy(sending = false, selectedSession = sessionWithMsg, showDetail = true)
                refresh()
            } catch (e: Exception) {
                _state.value = _state.value.copy(sending = false, error = e.message ?: "新建会话失败")
            }
        }
    }

    fun decideApproval(approvalId: String, action: String) {
        val session = _state.value.selectedSession ?: return
        viewModelScope.launch {
            try {
                api.decideApproval(approvalId, action)
                val detail = api.sessionDetail(session.id)
                _state.value = _state.value.copy(selectedSession = detail)
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message ?: "审批失败")
            }
        }
    }

    fun setTheme(theme: AppTheme) {
        _state.value = _state.value.copy(theme = theme)
    }

    /** 打开模型选择：拉取当前 Agent 可用模型 */
    fun openModelSheet() {
        val session = _state.value.selectedSession ?: return
        viewModelScope.launch {
            try {
                val models = api.getModels(session.resolvedAgent.slug)
                _state.value = _state.value.copy(models = models, modelSheetVisible = true, currentModel = session.model ?: "")
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message ?: "模型列表加载失败")
            }
        }
    }

    fun closeModelSheet() {
        _state.value = _state.value.copy(modelSheetVisible = false)
    }

    /** 切换模型（下一轮生效），成功后刷新会话详情反映新模型 */
    fun setModel(modelId: String) {
        val session = _state.value.selectedSession ?: return
        viewModelScope.launch {
            try {
                api.setModel(session.id, modelId)
                _state.value = _state.value.copy(modelSheetVisible = false, currentModel = modelId)
                // 刷新详情（daemon 返回的 model 字段更新）
                val detail = api.sessionDetail(session.id)
                _state.value = _state.value.copy(selectedSession = detail)
            } catch (e: Exception) {
                _state.value = _state.value.copy(error = e.message ?: "模型切换失败")
            }
        }
    }

    /** 拉取命令列表（供 / 命令拾取器） */
    fun loadCommands(agent: String, cwd: String = "", sessionId: String = "") {
        viewModelScope.launch {
            try {
                val commands = api.getCommands(agent, cwd, sessionId)
                _state.value = _state.value.copy(commands = commands)
            } catch (_: Exception) {
                _state.value = _state.value.copy(commands = emptyList())
            }
        }
    }

    /** 订阅 SSE 事件：只在已配对且有 token 时建立连接；收到事件后刷新列表/详情 */
    fun subscribeEvents() {
        if (!_state.value.paired || api.token.isEmpty()) return
        api.subscribeEvents()
        viewModelScope.launch {
            api.events.collect { payload ->
                // conn 事件只是连接状态提示，不触发刷新风暴；业务事件才刷新
                if (payload.contains("\"type\":\"approval\"") || payload.contains("\"type\":\"status\"") ||
                    payload.contains("\"type\":\"session\"")
                ) {
                    refresh()
                }
            }
        }
    }
}
