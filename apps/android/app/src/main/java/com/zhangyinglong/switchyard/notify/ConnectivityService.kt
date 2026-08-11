package com.zhangyinglong.switchyard.notify

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.content.ContextCompat
import com.zhangyinglong.switchyard.net.ApiClient
import com.zhangyinglong.switchyard.security.TokenStore
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * 前台服务：保持与 Session-Core daemon 的 SSE 长连接。
 * - 收到审批事件 → 高优先级通知 + 锁屏快捷动作
 * - 收到任务状态变化 → 低优先级通知
 * - 断线自动重连（指数退避，P4 保活）
 */
class ConnectivityService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var api: ApiClient? = null
    private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!running) {
            running = true
            ensureChannels() // 必须先建 channel，startForeground 才能正确显示
            startForeground(1, NotificationHelper.foregroundNotification(this))
            connect()
        }
        return START_STICKY
    }

    private fun ensureChannels() {
        NotificationHelper.ensureChannels(this)
    }

    private fun connect() {
        val store = TokenStore(this)
        val baseUrl = store.loadBaseUrl() ?: return
        val token = store.loadToken() ?: return

        val client = ApiClient()
        client.configure(baseUrl, token)
        api = client

        scope.launch {
            var attempt = 0
            while (isActive) {
                try {
                    attempt = 0 // 连接成功后重置退避
                    client.events.collectLatest { payload ->
                        handleEvent(payload)
                    }
                } catch (_: CancellationException) {
                    break
                } catch (_: Exception) {
                }
                // 断线退避重连
                attempt++
                delay((minOf(attempt, 6) * 3000).toLong())
            }
        }
    }

    private fun handleEvent(payload: String) {
        try {
            val json = Json.parseToJsonElement(payload).jsonObject
            val type = json["type"]?.jsonPrimitive?.content ?: return
            when (type) {
                "approval" -> {
                    val id = json["id"]?.jsonPrimitive?.content ?: ""
                    val summary = json["summary"]?.jsonPrimitive?.content
                        ?: json["title"]?.jsonPrimitive?.content ?: "Agent 需要你的审批"
                    val sessionId = json["sessionId"]?.jsonPrimitive?.content ?: ""
                    if (id.isNotEmpty()) {
                        NotificationHelper.notifyApproval(this, id, summary, sessionId)
                    }
                }
                "status" -> {
                    val summary = json["summary"]?.jsonPrimitive?.content ?: return
                    val sessionId = json["sessionId"]?.jsonPrimitive?.content ?: ""
                    NotificationHelper.notifyStatus(this, "Console", summary, sessionId)
                }
            }
        } catch (_: Exception) {
        }
    }

    override fun onDestroy() {
        running = false
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, ConnectivityService::class.java)
            )
        }
    }
}
