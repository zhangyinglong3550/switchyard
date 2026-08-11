package com.zhangyinglong.switchyard.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zhangyinglong.switchyard.data.AgentId
import com.zhangyinglong.switchyard.data.SessionSummary
import com.zhangyinglong.switchyard.ui.theme.AppTheme
import com.zhangyinglong.switchyard.ui.theme.ThemeColors
import com.zhangyinglong.switchyard.ui.theme.Themes
import com.zhangyinglong.switchyard.ui.theme.Themes.agentAccent
import com.zhangyinglong.switchyard.ui.theme.Themes.agentSoft

/** 底部面板指示点（保留给抽屉选中项展示，或可移除） */
@Composable
fun PagerDots(
    count: Int,
    current: Int,
    accent: Color,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        repeat(count) { i ->
            Box(
                modifier = Modifier
                    .width(if (i == current) 18.dp else 6.dp)
                    .height(6.dp)
                    .clip(CircleShape)
                    .background(if (i == current) accent else Color(0xFF3A3A3C))
            )
        }
    }
}

/** 会话卡片 */
@Composable
fun SessionCard(
    session: SessionSummary,
    theme: ThemeColors,
    appTheme: AppTheme,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val accent = agentAccent(session.resolvedAgent, appTheme)
    val soft = agentSoft(session.resolvedAgent, appTheme)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(theme.card)
            .clickable(onClick = onClick)
            .padding(16.dp, 16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .background(soft),
                contentAlignment = Alignment.Center
            ) {
                Text(session.resolvedAgent.short, color = accent, fontWeight = FontWeight.ExtraBold, fontSize = 11.sp)
            }
            Spacer(Modifier.width(8.dp))
            Text(
                session.title,
                modifier = Modifier.weight(1f),
                color = theme.text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                maxLines = 1
            )
            Spacer(Modifier.width(6.dp))
            Text(relativeTime(session.updatedAt), color = theme.text3, fontSize = 11.sp)
        }
        Spacer(Modifier.height(7.dp))
        Text(
            session.preview,
            color = theme.text2, fontSize = 13.sp, lineHeight = 18.sp, maxLines = 2
        )
        Spacer(Modifier.height(9.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            val statusColor = when {
                session.isRunning -> accent
                session.needsApproval -> Themes.approvalAmber
                session.isFailed -> Themes.failedRed
                else -> theme.text3
            }
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(statusColor)
            )
            Spacer(Modifier.width(6.dp))
            Text(
                when {
                    session.isRunning -> "运行中"
                    session.needsApproval -> "待审批"
                    session.isFailed -> "失败"
                    else -> "已完成"
                },
                color = if (session.isRunning) accent else theme.text2,
                fontWeight = FontWeight.SemiBold, fontSize = 11.sp
            )
            Spacer(Modifier.weight(1f))
            if (session.fileCount > 0) {
                Text("${session.fileCount} 个文件", color = theme.text3, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

private fun relativeTime(iso: String): String = com.zhangyinglong.switchyard.util.TimeUtil.relativeTime(iso)

/** 会话列表（按当前选中 Agent 过滤 + 项目分组 + 搜索） */
@Composable
fun SessionListPanel(
    agent: AgentId,
    sessions: List<SessionSummary>,
    theme: ThemeColors,
    appTheme: AppTheme,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var query by remember { mutableStateOf("") }
    val filtered = if (agent == AgentId.ALL) sessions else sessions.filter { it.resolvedAgent == agent }
    val searched = remember(filtered, query) {
        if (query.isBlank()) filtered
        else filtered.filter {
            it.title.contains(query, ignoreCase = true) || it.preview.contains(query, ignoreCase = true)
        }
    }
    // 按项目分组（project 或 directory 取末一段作为组名，避免长路径撑爆标题）
    val grouped = remember(searched) {
        searched.groupBy { session ->
            val raw = when {
                session.project.isNotBlank() -> session.project
                session.directory.isNotBlank() -> session.directory.trimEnd('/').split('/').takeLast(2).joinToString("/")
                else -> "其他"
            }
            // 取末一段（project 名或目录名），超长截断
            val last = raw.trimEnd('/').split('/').last()
            if (last.length > 22) last.take(22) + "…" else last
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 18.dp)
            .padding(top = 12.dp)
    ) {
        // 搜索框
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(theme.inputBg)
                .padding(horizontal = 14.dp, vertical = 9.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("🔍", fontSize = 12.sp)
                Spacer(Modifier.width(8.dp))
                if (query.isEmpty()) {
                    Text("搜索会话…", color = theme.text3, fontSize = 13.sp)
                }
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    textStyle = TextStyle(color = theme.text, fontSize = 13.sp),
                    modifier = Modifier.weight(1f)
                )
                if (query.isNotEmpty()) {
                    Box(
                        modifier = Modifier
                            .size(20.dp)
                            .clip(CircleShape)
                            .clickableNoRipple { query = "" },
                        contentAlignment = Alignment.Center
                    ) {
                        Text("×", color = theme.text3, fontSize = 13.sp)
                    }
                }
            }
        }
        Spacer(Modifier.height(8.dp))

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (searched.isEmpty()) {
                item {
                    Text(
                        if (agent == AgentId.ALL) "暂无会话" else "暂无 ${agent.label} 会话",
                        color = theme.text3,
                        fontSize = 14.sp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 40.dp),
                        textAlign = TextAlign.Center
                    )
                }
                return@LazyColumn
            }
            grouped.forEach { (groupName, groupSessions) ->
                item(key = "header-$groupName") {
                    Text(
                        groupName,
                        color = theme.text3,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 1.sp,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 6.dp, bottom = 2.dp)
                    )
                }
                items(groupSessions, key = { it.id }) { session ->
                    SessionCard(session, theme, appTheme, onClick = { onOpen(session.id) })
                }
            }
        }
    }
}

/** Agent 抽屉内容 */
@Composable
fun AgentDrawerContent(
    current: AgentId,
    sessionCounts: Map<AgentId, Int>,
    theme: ThemeColors,
    appTheme: AppTheme,
    onSelect: (AgentId) -> Unit,
    modifier: Modifier = Modifier
) {
    val items = listOf(
        AgentId.ALL, AgentId.GROK, AgentId.CODEX, AgentId.CLAUDE, AgentId.OPENCODE
    )
    Column(modifier = modifier.fillMaxSize().background(theme.bg).statusBarsPadding().padding(top = 24.dp)) {
        Text(
            "AGENTS",
            color = theme.text3,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 2.sp,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp)
        )
        items.forEach { agent ->
            val accent = agentAccent(agent, appTheme)
            val soft = agentSoft(agent, appTheme)
            val selected = agent == current
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(if (selected) soft else Color.Transparent)
                    .clickable { onSelect(agent) }
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .clip(RoundedCornerShape(11.dp))
                        .background(soft),
                    contentAlignment = Alignment.Center
                ) {
                    Text(agent.short, color = accent, fontWeight = FontWeight.ExtraBold, fontSize = 13.sp)
                }
                Spacer(Modifier.width(12.dp))
                Text(
                    agent.label,
                    color = if (selected) accent else theme.text,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                    fontSize = 14.5.sp,
                    modifier = Modifier.weight(1f)
                )
                val count = sessionCounts[agent] ?: 0
                if (count > 0) {
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(soft)
                            .padding(horizontal = 8.dp, vertical = 3.dp)
                    ) {
                        Text(count.toString(), color = accent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
                if (selected) {
                    Spacer(Modifier.width(8.dp))
                    Text("✓", color = accent, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

/**
 * 主列表：会话列表 + Agent 抽屉（从左侧拉出）。
 * 替代原 HorizontalPager 滑动面板。
 */
@Composable
fun SessionListWithDrawer(
    sessions: List<SessionSummary>,
    currentAgent: AgentId,
    drawerOpen: Boolean,
    theme: ThemeColors,
    appTheme: AppTheme,
    onAgentSelect: (AgentId) -> Unit,
    onDrawerToggle: () -> Unit,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    // 每个 Agent 的会话计数
    val counts = remember(sessions) {
        val m = mutableMapOf<AgentId, Int>()
        sessions.forEach { s ->
            val a = s.resolvedAgent
            m[a] = (m[a] ?: 0) + 1
        }
        m[AgentId.ALL] = sessions.size
        m
    }

    Box(modifier = modifier.fillMaxSize()) {
        // 会话列表
        SessionListPanel(
            agent = currentAgent,
            sessions = sessions,
            theme = theme,
            appTheme = appTheme,
            onOpen = onOpen,
            modifier = Modifier.fillMaxSize()
        )

        // 抽屉遮罩
        if (drawerOpen) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.45f))
                    .clickable(onClick = onDrawerToggle)
            )
        }

        // 抽屉（左侧滑入）
        AnimatedVisibility(
            visible = drawerOpen,
            enter = slideInHorizontally { -it },
            exit = slideOutHorizontally { -it },
            modifier = Modifier.fillMaxSize()
        ) {
            Box(modifier = Modifier.fillMaxWidth(0.72f).fillMaxHeight()) {
                AgentDrawerContent(
                    current = currentAgent,
                    sessionCounts = counts,
                    theme = theme,
                    appTheme = appTheme,
                    onSelect = { agent ->
                        onAgentSelect(agent)
                        onDrawerToggle()
                    }
                )
            }
        }
    }
}
