package com.zhangyinglong.switchyard.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.zhangyinglong.switchyard.MainActivity
import com.zhangyinglong.switchyard.R

/**
 * 本地通知：任务状态变化 + 审批提醒（带锁屏快捷动作）。
 * 数据经 Tailscale 从 daemon 推送到手机，由本机发通知（无需 FCM）。
 */
object NotificationHelper {
    const val CHANNEL_STATUS = "switchyard_status"
    const val CHANNEL_APPROVAL = "switchyard_approval"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_STATUS, "任务状态", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Agent 任务运行/完成/失败"
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVAL, "待审批", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Agent 需要你审批变更"
            }
        )
    }

    /** 审批通知：带「同意 / 拒绝」锁屏快捷动作 */
    fun notifyApproval(context: Context, approvalId: String, summary: String, sessionId: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("sessionId", sessionId)
        }
        val openPi = PendingIntent.getActivity(context, approvalId.hashCode(), openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val approveIntent = ApprovalActionReceiver.approveIntent(context, approvalId, sessionId)
        val rejectIntent = ApprovalActionReceiver.rejectIntent(context, approvalId, sessionId)

        val notification = NotificationCompat.Builder(context, CHANNEL_APPROVAL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("需要审批")
            .setContentText(summary)
            .setStyle(NotificationCompat.BigTextStyle().bigText(summary))
            .setContentIntent(openPi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(0, "拒绝", rejectIntent)
            .addAction(0, "同意", approveIntent)
            .build()

        nm.notify("approval-$approvalId", approvalId.hashCode(), notification)
    }

    /** 任务状态通知 */
    fun notifyStatus(context: Context, title: String, text: String, sessionId: String? = null) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            sessionId?.let { putExtra("sessionId", it) }
        }
        val openPi = PendingIntent.getActivity(context, title.hashCode(), openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val notification = NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openPi)
            .setAutoCancel(true)
            .build()

        nm.notify("status", title.hashCode(), notification)
    }

    /** 前台服务常驻通知 */
    fun foregroundNotification(context: Context): Notification =
        NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Console 已连接")
            .setContentText("正在监听 Mac 上的 Agent 任务")
            .setOngoing(true)
            .setSilent(true)
            .build()
}
