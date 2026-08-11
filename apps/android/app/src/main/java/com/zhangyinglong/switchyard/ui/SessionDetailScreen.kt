package com.zhangyinglong.switchyard.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.zhangyinglong.switchyard.data.AgentId
import com.zhangyinglong.switchyard.data.ApprovalItem
import com.zhangyinglong.switchyard.data.CommandInfo
import com.zhangyinglong.switchyard.data.ModelInfo
import com.zhangyinglong.switchyard.data.SessionDetail
import com.zhangyinglong.switchyard.data.SessionMessage
import com.zhangyinglong.switchyard.ui.theme.AppTheme
import com.zhangyinglong.switchyard.ui.theme.Themes
import com.zhangyinglong.switchyard.ui.theme.ThemeColors
import com.zhangyinglong.switchyard.ui.theme.Themes.agentAccent

/** 消息气泡 */
@Composable
private fun MessageBubble(msg: SessionMessage, theme: ThemeColors, appTheme: AppTheme, agentId: String) {
    val accent = agentAccent(AgentId.fromSlug(agentId), appTheme)
    when {
        msg.isUser -> {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .wrapContentWidth(Alignment.End)
                    .padding(vertical = 3.dp)
            ) {
                Text(
                    msg.text,
                    modifier = Modifier
                        .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 20.dp, bottomEnd = 6.dp))
                        .background(accent)
                        .padding(13.dp, 13.dp),
                    color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium, lineHeight = 21.sp
                )
            }
        }
        msg.isTool -> {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 3.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(theme.toolBg)
                    .padding(14.dp, 12.dp)
            ) {
                Text(
                    "🔧 已执行 · ${msg.tool?.name ?: "tool"}",
                    color = theme.text, fontWeight = FontWeight.Bold, fontSize = 12.sp
                )
                Spacer(Modifier.height(5.dp))
                Text(
                    msg.tool?.content ?: msg.text,
                    color = theme.text2, fontSize = 11.5.sp, fontFamily = FontFamily.Monospace, lineHeight = 18.sp
                )
            }
        }
        else -> {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .wrapContentWidth(Alignment.Start)
                    .padding(vertical = 3.dp)
            ) {
                Text(
                    AgentId.fromSlug(agentId).label,
                    color = accent, fontWeight = FontWeight.Bold, fontSize = 11.sp
                )
                Spacer(Modifier.height(4.dp))
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 6.dp, bottomEnd = 20.dp))
                        .background(theme.msgAssistantBg)
                        .padding(horizontal = 13.dp, vertical = 11.dp)
                ) {
                    // Markdown 渲染：agent 输出不再原样显示 **、#、``` 等标记
                    MarkdownBody(msg.text, theme)
                }
            }
        }
    }
}

/** diff 审批卡片（选项式：遍历 daemon approval.options，支持命令预览 + 取消） */
@Composable
private fun DiffCard(approval: ApprovalItem, theme: ThemeColors, appTheme: AppTheme, agentId: String, onDecide: (String, String) -> Unit) {
    val accent = agentAccent(AgentId.fromSlug(agentId), appTheme)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(theme.diffBg)
    ) {
        // 头部：文件 / 审批类型
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(theme.diffFileBg)
                .padding(12.dp, 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(if (approval.type == "edit") "📄" else "🔧", fontSize = 13.sp)
            Spacer(Modifier.width(6.dp))
            Text(
                approval.file.ifBlank { approval.summary }.ifBlank { "审批请求" },
                color = theme.text, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                modifier = Modifier.weight(1f)
            )
            if (approval.type != "edit" && approval.additions + approval.deletions > 0) {
                Text("+${approval.additions} −${approval.deletions}", color = Themes.diffAdd, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
            }
        }

        // 命令预览（非 edit 类，如 run_command / apply_patch）
        if (approval.commandLine.isNotBlank()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 4.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(theme.toolBg)
                    .padding(horizontal = 10.dp, vertical = 8.dp)
            ) {
                Text(
                    approval.commandLine,
                    color = theme.text2, fontSize = 11.5.sp, fontFamily = FontFamily.Monospace, lineHeight = 17.sp
                )
            }
        }

        // diff 内容（edit 类）
        if (approval.diff.isNotBlank()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(14.dp, 8.dp)
            ) {
                approval.diff.lineSequence().forEach { line ->
                    val bg = when {
                        line.startsWith("+") -> Color(0x1F1F9D55)
                        line.startsWith("-") -> Color(0x1AE0352B)
                        else -> Color.Transparent
                    }
                    val fg = when {
                        line.startsWith("+") -> Themes.diffAdd
                        line.startsWith("-") -> Themes.diffDel
                        else -> theme.text3
                    }
                    Text(
                        line,
                        color = fg, fontSize = 11.5.sp, fontFamily = FontFamily.Monospace, lineHeight = 19.sp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(bg, RoundedCornerShape(3.dp))
                    )
                }
            }
        }

        // 审批摘要（非 edit 类）
        if (approval.type != "edit" && approval.summary.isNotBlank() && approval.file.isBlank()) {
            Text(
                approval.summary,
                color = theme.text, fontSize = 13.sp, lineHeight = 19.sp,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp)
            )
        }

        // 选项式审批（对齐 daemon approval.options）
        val options = approval.options
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 16.dp, bottom = 14.dp)
        ) {
            if (options.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                options.forEachIndexed { index, option ->
                    val optionColor = when (option.kind) {
                        "allow_once", "allow_session" -> Themes.diffAdd
                        "deny_once", "reject_once" -> Themes.diffDel
                        else -> theme.text
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(optionColor.copy(alpha = 0.08f))
                            .clickableNoRipple { onDecide(approval.id, option.kind) }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("${index + 1}.", color = optionColor, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                        Spacer(Modifier.width(10.dp))
                        Text(
                            option.label.ifBlank { option.kind },
                            color = theme.text, fontWeight = FontWeight.Medium, fontSize = 13.sp,
                            modifier = Modifier.weight(1f)
                        )
                        Text("→", color = optionColor, fontSize = 13.sp)
                    }
                    Spacer(Modifier.height(6.dp))
                }
            }
            // 取消
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(theme.cardHover)
                    .clickableNoRipple { onDecide(approval.id, "cancel") }
                    .padding(vertical = 9.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("取消", color = theme.text3, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

/** 会话详情页 */
@Composable
fun SessionDetailScreen(
    session: SessionDetail,
    theme: ThemeColors,
    appTheme: AppTheme,
    sending: Boolean,
    models: List<ModelInfo>,
    commands: List<CommandInfo>,
    modelSheetVisible: Boolean,
    currentModel: String,
    pendingImages: List<com.zhangyinglong.switchyard.data.Attachment> = emptyList(),
    onBack: () -> Unit,
    onSend: (String) -> Unit,
    onDecide: (String, String) -> Unit,
    onOpenModelSheet: () -> Unit,
    onCloseModelSheet: () -> Unit,
    onSetModel: (String) -> Unit,
    onPickImage: () -> Unit = {},
    onRemoveImage: (Int) -> Unit = {},
    modifier: Modifier = Modifier
) {
    val accent = agentAccent(session.resolvedAgent, appTheme)
    var input by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }

    // 命令拾取器状态
    var commandOpen by remember { mutableStateOf(false) }
    var commandSelected by remember { mutableStateOf(0) }
    val commandFilter = remember(input) {
        Markdown.filterCommands(input, commands.map {
            Markdown.CommandCandidate(it.id, it.name, it.description, it.insertText)
        })
    }

    // 系统返回键：先关命令/模型 sheet，再返回列表
    BackHandler {
        when {
            commandOpen -> commandOpen = false
            modelSheetVisible -> onCloseModelSheet()
            else -> onBack()
        }
    }

    Column(modifier = modifier.fillMaxSize().background(theme.bg)) {
        // 头部
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(theme.composerBg)
                .statusBarsPadding()
                .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(theme.card)
                    .clickableNoRipple(onClick = onBack),
                contentAlignment = Alignment.Center
            ) {
                Text("‹", color = theme.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(10.dp))
            Text(
                session.title,
                modifier = Modifier.weight(1f),
                color = theme.text, fontWeight = FontWeight.Bold, fontSize = 16.sp, maxLines = 1
            )
            // 当前模型标签
            val modelLabel = currentModel.ifBlank { session.model }.ifBlank { "模型" }
            Text(
                modelLabel.substringAfterLast('/'),
                color = accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1
            )
        }

        // 消息流
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(18.dp, 14.dp, 18.dp, 20.dp)
        ) {
            items(session.messages) { msg -> MessageBubble(msg, theme, appTheme, session.resolvedAgent.slug) }
            items(session.pendingApprovals) { approval ->
                DiffCard(approval, theme, appTheme, session.resolvedAgent.slug, onDecide)
            }
        }

        // 输入条（底部 padding 防导航栏遮挡；不用 imePadding 避免键盘弹出时布局错乱）
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(theme.composerBg)
                .padding(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 32.dp)
                .navigationBarsPadding()
        ) {
            // 命令拾取器（overlay，输入 / 时显示）
            if (commandOpen) {
                CommandPicker(
                    candidates = commandFilter,
                    selected = commandSelected,
                    theme = theme,
                    onSelect = { candidate ->
                        input = candidate.insertText
                        commandOpen = false
                    },
                    onDismiss = { commandOpen = false }
                )
                Spacer(Modifier.height(8.dp))
            }
            // 图片附件缩略图
            if (pendingImages.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    pendingImages.forEachIndexed { index, _ ->
                        Box {
                            Box(
                                modifier = Modifier
                                    .size(52.dp)
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(theme.inputBg)
                                    .clickableNoRipple(onClick = { onRemoveImage(index) }),
                                contentAlignment = Alignment.Center
                            ) {
                                Text("🖼", fontSize = 18.sp)
                            }
                            // 右上角删除
                            Box(
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .size(18.dp)
                                    .clip(CircleShape)
                                    .background(Color.Black.copy(alpha = 0.6f))
                                    .clickableNoRipple { onRemoveImage(index) },
                                contentAlignment = Alignment.Center
                            ) {
                                Text("×", color = Color.White, fontSize = 11.sp)
                            }
                        }
                    }
                    Text(
                        "${pendingImages.size}/4",
                        color = theme.text3, fontSize = 11.sp,
                        modifier = Modifier.align(Alignment.CenterVertically)
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                // 附件按钮（文件/图片）
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(theme.card)
                        .clickableNoRipple(onClick = onPickImage),
                    contentAlignment = Alignment.Center
                ) {
                    Text("📎", fontSize = 14.sp)
                }
                Spacer(Modifier.width(8.dp))
                // 模型按钮
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(theme.card)
                        .clickableNoRipple(onClick = onOpenModelSheet),
                    contentAlignment = Alignment.Center
                ) {
                    Text("⚙", fontSize = 15.sp, color = theme.text)
                }
                Spacer(Modifier.width(8.dp))
                // 输入框
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(22.dp))
                        .background(theme.inputBg)
                        .padding(horizontal = 16.dp, vertical = 11.dp)
                ) {
                    if (input.isEmpty()) {
                        Text("输入消息，/ 查看命令…", color = theme.text3, fontSize = 14.sp)
                    }
                    BasicTextField(
                        value = input,
                        onValueChange = { newValue ->
                            input = newValue
                            // 输入 / 触发命令拾取器
                            if (newValue.startsWith("/")) {
                                commandOpen = true
                                commandSelected = 0
                            } else if (!newValue.startsWith("/")) {
                                commandOpen = false
                            }
                        },
                        textStyle = TextStyle(color = theme.text, fontSize = 14.sp),
                        cursorBrush = SolidColor(accent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focusRequester)
                    )
                }
                Spacer(Modifier.width(8.dp))
                // 发送按钮
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(if (sending) theme.text3 else accent)
                        .clickableNoRipple {
                            if (input.isNotBlank() && !sending) {
                                onSend(input)
                                input = ""
                            }
                        },
                    contentAlignment = Alignment.Center
                ) {
                    Text("➤", color = if (sending) theme.bg else Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp)
                }
            }
        }
    }

    // 模型选择 sheet（Dialog）
    if (modelSheetVisible) {
        Dialog(onDismissRequest = onCloseModelSheet) {
            ModelSheet(
                models = models,
                currentModel = currentModel.ifBlank { session.model },
                theme = theme,
                onSelect = onSetModel,
                onClose = onCloseModelSheet
            )
        }
    }
}

/** 命令拾取器 */
@Composable
private fun CommandPicker(
    candidates: List<Markdown.CommandCandidate>,
    selected: Int,
    theme: ThemeColors,
    onSelect: (Markdown.CommandCandidate) -> Unit,
    onDismiss: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(theme.diffBg)
            .clickableNoRipple(onClick = {}) // 拦截点击，避免冒泡
    ) {
        if (candidates.isEmpty()) {
            Text(
                "没有匹配的命令",
                color = theme.text3, fontSize = 13.sp,
                modifier = Modifier.padding(16.dp, 14.dp)
            )
        } else {
            candidates.forEachIndexed { index, candidate ->
                val isSelected = index == selected
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(if (isSelected) theme.cardHover else Color.Transparent)
                        .clickableNoRipple { onSelect(candidate) }
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        candidate.insertText.ifBlank { "/${candidate.name}" },
                        color = if (isSelected) theme.text else theme.text2,
                        fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                        fontFamily = FontFamily.Monospace
                    )
                    Spacer(Modifier.width(10.dp))
                    Text(
                        candidate.description,
                        color = theme.text3, fontSize = 11.sp, maxLines = 1,
                        modifier = Modifier.weight(1f)
                    )
                }
            }
        }
    }
}

/** 模型选择 sheet */
@Composable
private fun ModelSheet(
    models: List<ModelInfo>,
    currentModel: String,
    theme: ThemeColors,
    onSelect: (String) -> Unit,
    onClose: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(theme.bg)
            .padding(vertical = 20.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("选择模型", color = theme.text, fontWeight = FontWeight.Bold, fontSize = 17.sp, modifier = Modifier.weight(1f))
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .clip(CircleShape)
                    .background(theme.card)
                    .clickableNoRipple(onClick = onClose),
                contentAlignment = Alignment.Center
            ) {
                Text("✕", color = theme.text2, fontSize = 13.sp)
            }
        }
        Text("模型将在下一轮生效", color = theme.text3, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 20.dp))
        Spacer(Modifier.height(10.dp))
        if (models.isEmpty()) {
            Text("当前 Agent 没有可用模型", color = theme.text3, fontSize = 13.sp, modifier = Modifier.padding(20.dp))
        } else {
            LazyColumn(modifier = Modifier.heightIn(max = 360.dp)) {
                items(models) { model ->
                    val selected = model.id == currentModel
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickableNoRipple { onSelect(model.id) }
                            .padding(horizontal = 20.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                model.name,
                                color = theme.text,
                                fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                                fontSize = 14.sp
                            )
                            Text(
                                model.provider.ifBlank { "可用" },
                                color = theme.text3, fontSize = 11.sp
                            )
                        }
                        if (selected) Text("✓", color = Themes.diffAdd, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}
