package com.zhangyinglong.switchyard.ui.theme

import androidx.compose.ui.graphics.Color
import com.zhangyinglong.switchyard.data.AgentId

/** 4 套皮肤主题（对应 HTML 预览 v4） */
enum class AppTheme(val key: String, val label: String) {
    DARK("dark", "深色"),
    WARM("warm", "暖色"),
    WHITE("white", "白色"),
    LIGHT("light", "浅灰");

    companion object {
        fun fromKey(key: String?): AppTheme = entries.firstOrNull { it.key == key } ?: DARK
    }
}

data class ThemeColors(
    val bg: Color,
    val card: Color,
    val cardHover: Color,
    val text: Color,
    val text2: Color,
    val text3: Color,
    val composerBg: Color,
    val inputBg: Color,
    val diffBg: Color,
    val diffFileBg: Color,
    val msgAssistantBg: Color,
    val toolBg: Color,
    val toolBorder: Color,
    val pageBg: Color
)

object Themes {
    fun colors(theme: AppTheme): ThemeColors = when (theme) {
        AppTheme.DARK -> ThemeColors(
            bg = Color(0xFF000000), card = Color(0xFF141414), cardHover = Color(0xFF1A1A1A),
            text = Color(0xFFF5F5F7), text2 = Color(0xFF8E8E93), text3 = Color(0xFF636366),
            composerBg = Color(0xB30A0A0A), inputBg = Color(0xFF1C1C1E),
            diffBg = Color(0xFF141414), diffFileBg = Color(0xFF1C1C1E),
            msgAssistantBg = Color(0xFF1C1C1E), toolBg = Color(0xFF111111), toolBorder = Color(0xFF222222),
            pageBg = Color(0xFF050505)
        )
        AppTheme.WARM -> ThemeColors(
            bg = Color(0xFFF7F1E7), card = Color(0xFFFFFDF8), cardHover = Color(0xFFF9F3E8),
            text = Color(0xFF3D352B), text2 = Color(0xFF8A7D6A), text3 = Color(0xFFB0A48F),
            composerBg = Color(0xE6F7F1E7), inputBg = Color(0xFFFFFDF8),
            diffBg = Color(0xFFFFFDF8), diffFileBg = Color(0xFFF3EBDD),
            msgAssistantBg = Color(0xFFFFFDF8), toolBg = Color(0xFFF6EFE3), toolBorder = Color(0xFFE6DCC9),
            pageBg = Color(0xFFF4ECE0)
        )
        AppTheme.WHITE -> ThemeColors(
            bg = Color(0xFFFFFFFF), card = Color(0xFFF5F5F7), cardHover = Color(0xFFECECEF),
            text = Color(0xFF1C1C1E), text2 = Color(0xFF6E6E73), text3 = Color(0xFFAEAEB2),
            composerBg = Color(0xD9FFFFFF), inputBg = Color(0xFFF5F5F7),
            diffBg = Color(0xFFF5F5F7), diffFileBg = Color(0xFFECECEF),
            msgAssistantBg = Color(0xFFF5F5F7), toolBg = Color(0xFFF2F2F5), toolBorder = Color(0xFFE4E4E7),
            pageBg = Color(0xFFF0F0F2)
        )
        AppTheme.LIGHT -> ThemeColors(
            bg = Color(0xFFF2F2F7), card = Color(0xFFFFFFFF), cardHover = Color(0xFFF7F7FA),
            text = Color(0xFF1C1C1E), text2 = Color(0xFF6E6E73), text3 = Color(0xFFAEAEB2),
            composerBg = Color(0xE0F2F2F7), inputBg = Color(0xFFF2F2F7),
            diffBg = Color(0xFFFFFFFF), diffFileBg = Color(0xFFF2F2F7),
            msgAssistantBg = Color(0xFFFFFFFF), toolBg = Color(0xFFF7F7FA), toolBorder = Color(0xFFE1E1E6),
            pageBg = Color(0xFFECECF1)
        )
    }

    /** Agent 氛围色（深色主题用亮色，浅色主题加深保证对比度） */
    fun agentAccent(agent: AgentId, theme: AppTheme): Color {
        val dark = theme == AppTheme.DARK
        return when (agent) {
            AgentId.ALL -> if (dark) Color(0xFFFF9F0A) else Color(0xFFD97706)
            AgentId.GROK -> if (dark) Color(0xFFFF453A) else Color(0xFFE0352B)
            AgentId.CODEX -> if (dark) Color(0xFF30D158) else Color(0xFF1F9D55)
            AgentId.CLAUDE -> if (dark) Color(0xFFFFB340) else Color(0xFFB8860B)
            AgentId.OPENCODE -> if (dark) Color(0xFF0A84FF) else Color(0xFF0A63D6)
        }
    }

    fun agentSoft(agent: AgentId, theme: AppTheme): Color {
        val accent = agentAccent(agent, theme)
        return accent.copy(alpha = 0.12f)
    }

    /** 状态色 */
    val approvalAmber = Color(0xFFE8A33D)
    val failedRed = Color(0xFFFF453A)
    val diffAdd = Color(0xFF1F9D55)
    val diffDel = Color(0xFFE0352B)
}
