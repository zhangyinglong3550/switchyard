package com.zhangyinglong.switchyard

import com.zhangyinglong.switchyard.data.AgentId
import com.zhangyinglong.switchyard.data.Attachment
import com.zhangyinglong.switchyard.data.SessionMessage
import com.zhangyinglong.switchyard.data.SessionSummary
import com.zhangyinglong.switchyard.util.TimeUtil
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.OffsetDateTime

class TimeUtilTest {
    @Test
    fun `relativeTime 解析各档位`() {
        val now = OffsetDateTime.parse("2026-08-08T12:00:00Z")
        assertEquals("刚刚", TimeUtil.relativeTime("2026-08-08T11:59:30Z", now))
        assertEquals("5 分钟前", TimeUtil.relativeTime("2026-08-08T11:55:00Z", now))
        assertEquals("3 小时前", TimeUtil.relativeTime("2026-08-08T09:00:00Z", now))
        assertEquals("2 天前", TimeUtil.relativeTime("2026-08-06T12:00:00Z", now))
    }

    @Test
    fun `relativeTime 非法输入返回空`() {
        assertEquals("", TimeUtil.relativeTime("not-a-date"))
        assertEquals("", TimeUtil.relativeTime(""))
    }
}

class ModelsTest {
    @Test
    fun `SessionSummary 状态判定`() {
        assertTrue(SessionSummary(state = "running").isRunning)
        assertTrue(SessionSummary(state = "awaiting_approval").needsApproval)
        assertTrue(SessionSummary(state = "failed").isFailed)
        assertFalse(SessionSummary(state = "completed").isRunning)
        assertFalse(SessionSummary(state = "completed").needsApproval)
    }

    @Test
    fun `AgentId fromSlug 映射`() {
        assertEquals(AgentId.GROK, AgentId.fromSlug("grok"))
        assertEquals(AgentId.CODEX, AgentId.fromSlug("codex"))
        assertEquals(AgentId.CLAUDE, AgentId.fromSlug("claude-code"))
        assertEquals(AgentId.OPENCODE, AgentId.fromSlug("opencode"))
        assertEquals(AgentId.ALL, AgentId.fromSlug("unknown"))
        assertEquals(AgentId.ALL, AgentId.fromSlug(null))
    }

    @Test
    fun `SessionMessage 角色判定`() {
        assertTrue(SessionMessage(role = "user").isUser)
        assertTrue(SessionMessage(kind = "tool").isTool)
        assertTrue(SessionMessage(toolJson = "{}").isTool)
        assertFalse(SessionMessage(role = "assistant").isUser)
    }

    @Test
    fun `Attachment JSON 序列化`() {
        val img = Attachment(kind = "image", name = "a.jpg", data = "aGVsbG8=", mimeType = "image/jpeg")
        val json = img.toJson()
        assertTrue(json.contains("\"kind\":\"image\""))
        assertTrue(json.contains("\"name\":\"a.jpg\""))
        assertTrue(json.contains("\"data\":\"aGVsbG8=\""))
        assertTrue(json.contains("\"mimeType\":\"image/jpeg\""))
        // 不含空字段
        assertFalse(json.contains("\"text\""))
        assertFalse(json.contains("\"path\""))
    }

    @Test
    fun `Attachment JSON 转义特殊字符`() {
        val a = Attachment(kind = "text", text = "含\"引号\"和\\反斜杠")
        val json = a.toJson()
        assertTrue(json.contains("\\\""))
        assertTrue(json.contains("\\\\"))
    }
}
