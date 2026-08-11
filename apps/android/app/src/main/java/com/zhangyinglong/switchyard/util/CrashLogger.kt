package com.zhangyinglong.switchyard.util

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 全局崩溃捕获：把未捕获异常栈写入 App 私有目录 crash.log。
 * 便于无 adb 时排查闪退（data/data/<pkg>/files/crash.log）。
 */
object CrashLogger {
    private var installed = false

    fun install(context: Context) {
        if (installed) return
        installed = true
        val dir = File(context.filesDir, "crash").apply { mkdirs() }
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val sw = StringWriter()
                throwable.printStackTrace(PrintWriter(sw))
                val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())
                val log = File(dir, "crash.log")
                log.appendText("===== $ts =====\nthread: ${thread.name}\n$sw\n\n")
            } catch (_: Exception) {
            }
            // 仍走系统默认处理（弹"已停止"）
            Thread.getDefaultUncaughtExceptionHandler()?.uncaughtException(thread, throwable)
        }
    }
}
