package com.zhangyinglong.switchyard.notify

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.zhangyinglong.switchyard.net.ApiClient
import com.zhangyinglong.switchyard.security.TokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 审批通知的锁屏快捷动作：同意 / 拒绝，直接调用 daemon 审批 API。
 */
class ApprovalActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val approvalId = intent.getStringExtra("approvalId") ?: return
        val action = intent.getStringExtra("action") ?: return
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        scope.launch {
            try {
                val store = TokenStore(context)
                val baseUrl = store.loadBaseUrl() ?: return@launch
                val token = store.loadToken() ?: return@launch
                val api = ApiClient()
                api.configure(baseUrl, token)
                api.decideApproval(approvalId, action)
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        fun approveIntent(context: Context, approvalId: String, sessionId: String): PendingIntent =
            actionIntent(context, approvalId, sessionId, "allow_once")

        fun rejectIntent(context: Context, approvalId: String, sessionId: String): PendingIntent =
            actionIntent(context, approvalId, sessionId, "reject_once")

        private fun actionIntent(context: Context, approvalId: String, sessionId: String, action: String): PendingIntent {
            val intent = Intent(context, ApprovalActionReceiver::class.java).apply {
                putExtra("approvalId", approvalId)
                putExtra("action", action)
            }
            return PendingIntent.getBroadcast(context, (approvalId + action).hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
    }
}
