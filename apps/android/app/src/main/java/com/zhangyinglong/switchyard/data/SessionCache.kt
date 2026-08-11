package com.zhangyinglong.switchyard.data

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * 离线缓存：最近会话列表 + 最近打开的会话详情。
 * 网络不可用时回退展示缓存（P4）。
 */
class SessionCache(context: Context) {

    private val dir = File(context.cacheDir, "session_cache").apply { mkdirs() }
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun saveSessions(sessions: List<SessionSummary>) {
        try {
            File(dir, "sessions.json").writeText(json.encodeToString(sessions))
        } catch (_: Exception) {}
    }

    fun loadSessions(): List<SessionSummary> {
        return try {
            val f = File(dir, "sessions.json")
            if (!f.exists()) emptyList() else json.decodeFromString<List<SessionSummary>>(f.readText())
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun saveDetail(id: String, detail: SessionDetail) {
        try {
            File(dir, "detail_${id.hashCode()}.json").writeText(json.encodeToString(detail))
        } catch (_: Exception) {}
    }

    fun loadDetail(id: String): SessionDetail? {
        return try {
            val f = File(dir, "detail_${id.hashCode()}.json")
            if (!f.exists()) null else json.decodeFromString<SessionDetail>(f.readText())
        } catch (_: Exception) {
            null
        }
    }
}
