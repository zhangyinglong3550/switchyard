package com.zhangyinglong.switchyard.util

import java.time.OffsetDateTime

object TimeUtil {
    /** ISO 时间 → 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前） */
    fun relativeTime(iso: String, now: OffsetDateTime = OffsetDateTime.now()): String {
        return try {
            val parsed = OffsetDateTime.parse(iso)
            val minutes = java.time.Duration.between(parsed, now).toMinutes()
            when {
                minutes < 1 -> "刚刚"
                minutes < 60 -> "$minutes 分钟前"
                minutes < 1440 -> "${minutes / 60} 小时前"
                else -> "${minutes / 1440} 天前"
            }
        } catch (_: Exception) {
            ""
        }
    }
}
