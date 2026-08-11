package com.zhangyinglong.switchyard.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zhangyinglong.switchyard.data.AgentId
import com.zhangyinglong.switchyard.data.ModelInfo
import com.zhangyinglong.switchyard.ui.theme.AppTheme
import com.zhangyinglong.switchyard.ui.theme.ThemeColors
import com.zhangyinglong.switchyard.ui.theme.Themes

/** 顶部栏 */
@Composable
private fun TopBar(
    theme: ThemeColors,
    appTheme: AppTheme,
    onThemeChange: (AppTheme) -> Unit,
    onDrawerToggle: () -> Unit = {},
    onSettings: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(start = 16.dp, end = 22.dp, top = 14.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // 抽屉按钮
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(theme.card)
                .clickableNoRipple(onClick = onDrawerToggle),
            contentAlignment = Alignment.Center
        ) {
            Text("☰", color = theme.text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(10.dp))
        Text(
            "Console", color = theme.text,
            fontWeight = FontWeight.ExtraBold, fontSize = 24.sp, letterSpacing = (-0.5).sp,
            modifier = Modifier.weight(1f)
        )
        // 主题切换（深/暖/白/浅灰 循环）
        val themeLabel = when (appTheme) {
            AppTheme.DARK -> "深"
            AppTheme.WARM -> "暖"
            AppTheme.WHITE -> "白"
            AppTheme.LIGHT -> "浅"
        }
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(theme.card)
                .clickableNoRipple {
                    val next = when (appTheme) {
                        AppTheme.DARK -> AppTheme.WARM
                        AppTheme.WARM -> AppTheme.WHITE
                        AppTheme.WHITE -> AppTheme.LIGHT
                        AppTheme.LIGHT -> AppTheme.DARK
                    }
                    onThemeChange(next)
                }
                .padding(horizontal = 10.dp, vertical = 6.dp)
        ) {
            Text(themeLabel, color = theme.text2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.width(10.dp))
        Text("4 AGENTS", color = theme.text3, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.width(10.dp))
        // 设置（改连接地址 / 重新配对）
        Box(
            modifier = Modifier
                .size(34.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(theme.card)
                .clickableNoRipple(onClick = onSettings),
            contentAlignment = Alignment.Center
        ) {
            Text("⚙", color = theme.text2, fontSize = 14.sp)
        }
    }
}

/** 配对页 */
@Composable
fun PairScreen(
    theme: ThemeColors,
    appTheme: AppTheme,
    connecting: Boolean,
    error: String?,
    onPair: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var url by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    val accent = Themes.agentAccent(AgentId.ALL, appTheme)

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(theme.bg)
            .padding(28.dp)
            .systemBarsPadding(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text("Console", color = theme.text, fontWeight = FontWeight.ExtraBold, fontSize = 30.sp, letterSpacing = (-1).sp)
        Spacer(Modifier.height(8.dp))
        Text("连接你的 Mac 上的 Session-Core", color = theme.text2, fontSize = 14.sp)
        Spacer(Modifier.height(36.dp))

        // 服务器地址
        Text("Mac 地址", color = theme.text2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("https://your-mac.ts.net:17890", color = theme.text3, fontSize = 14.sp) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            textStyle = TextStyle(color = theme.text, fontSize = 14.sp),
            shape = RoundedCornerShape(16.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = accent,
                unfocusedBorderColor = Color.Transparent,
                cursorColor = accent,
                focusedContainerColor = theme.inputBg,
                unfocusedContainerColor = theme.inputBg
            )
        )
        Spacer(Modifier.height(16.dp))

        // 设备名
        Text("设备名称", color = theme.text2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(
            value = name,
            onValueChange = { name = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("我的手机", color = theme.text3, fontSize = 14.sp) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Done),
            textStyle = TextStyle(color = theme.text, fontSize = 14.sp),
            shape = RoundedCornerShape(16.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = accent,
                unfocusedBorderColor = Color.Transparent,
                cursorColor = accent,
                focusedContainerColor = theme.inputBg,
                unfocusedContainerColor = theme.inputBg
            )
        )
        Spacer(Modifier.height(24.dp))

        // 连接按钮
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(if (connecting) theme.text3 else accent)
                .clickableNoRipple { if (!connecting && url.isNotBlank()) onPair(url.trim()) }
                .padding(vertical = 15.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(if (connecting) "连接中…" else "连接并配对", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        }

        error?.let {
            Spacer(Modifier.height(16.dp))
            Text(it, color = Themes.failedRed, fontSize = 12.sp)
        }
    }
}

/** 主界面：顶部 + 会话列表(抽屉) + 详情覆盖 + 模型选择 */
@Composable
fun MainScreen(
    state: com.zhangyinglong.switchyard.ui.UiState,
    onPair: (String) -> Unit,
    onThemeChange: (AppTheme) -> Unit,
    onPanelChange: (AgentId) -> Unit,
    onOpen: (String) -> Unit,
    onBack: () -> Unit,
    onSend: (String) -> Unit,
    onDecide: (String, String) -> Unit,
    onOpenModelSheet: () -> Unit = {},
    onCloseModelSheet: () -> Unit = {},
    onSetModel: (String) -> Unit = {},
    onPickImage: () -> Unit = {},
    onRemoveImage: (Int) -> Unit = {},
    onNewSession: () -> Unit = {},
    onCloseNewSession: () -> Unit = {},
    onCreateSession: (String, String, String) -> Unit = { _, _, _ -> },
    modifier: Modifier = Modifier
) {
    val theme = Themes.colors(state.theme)
    var drawerOpen by remember { mutableStateOf(false) }
    var settingsOpen by remember { mutableStateOf(false) }

    if (!state.paired) {
        PairScreen(theme, state.theme, state.connecting, state.error, onPair, modifier)
        return
    }

    Box(modifier = modifier.fillMaxSize().background(theme.bg)) {
        Column(modifier = Modifier.fillMaxSize()) {
            TopBar(
                theme = theme,
                appTheme = state.theme,
                onThemeChange = onThemeChange,
                onDrawerToggle = { drawerOpen = !drawerOpen },
                onSettings = { settingsOpen = true }
            )
            SessionListWithDrawer(
                sessions = state.allSessions,
                currentAgent = state.currentPanel,
                drawerOpen = drawerOpen,
                theme = theme,
                appTheme = state.theme,
                onAgentSelect = onPanelChange,
                onDrawerToggle = { drawerOpen = !drawerOpen },
                onOpen = onOpen
            )
        }

        // 新建会话悬浮按钮
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 22.dp, bottom = 30.dp)
                .size(56.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(Themes.agentAccent(state.currentPanel, state.theme))
                .clickableNoRipple(onClick = onNewSession),
            contentAlignment = Alignment.Center
        ) {
            Text("＋", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        }

        // 详情覆盖
        AnimatedVisibility(
            visible = state.showDetail,
            enter = slideInHorizontally(tween(320)) { it } + fadeIn(tween(320)),
            exit = slideOutHorizontally(tween(320)) { it } + fadeOut(tween(320)),
            modifier = Modifier.fillMaxSize()
        ) {
            state.selectedSession?.let { session ->
                SessionDetailScreen(
                    session = session,
                    theme = theme,
                    appTheme = state.theme,
                    sending = state.sending,
                    models = state.models,
                    commands = state.commands,
                    modelSheetVisible = state.modelSheetVisible,
                    currentModel = state.currentModel,
                    pendingImages = state.pendingImages,
                    onBack = onBack,
                    onSend = onSend,
                    onDecide = onDecide,
                    onOpenModelSheet = onOpenModelSheet,
                    onCloseModelSheet = onCloseModelSheet,
                    onSetModel = onSetModel,
                    onPickImage = onPickImage,
                    onRemoveImage = onRemoveImage,
                    modifier = Modifier.fillMaxSize()
                )
            }
        }

        // 错误提示
        state.error?.let { err ->
            androidx.compose.foundation.layout.Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 40.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color(0xE61C1C1E))
                    .padding(12.dp, 10.dp)
            ) {
                Text(err, color = Color(0xFFFF6B61), fontSize = 12.sp)
            }
        }

        // 新建会话对话框
        if (state.newSessionDialogVisible) {
            androidx.compose.ui.window.Dialog(onDismissRequest = onCloseNewSession) {
                NewSessionDialog(
                    currentAgent = state.currentPanel,
                    models = state.models,
                    theme = theme,
                    appTheme = state.theme,
                    sending = state.sending,
                    onConfirm = onCreateSession,
                    onClose = onCloseNewSession
                )
            }
        }

        // 设置对话框（改连接地址 / 重新配对）
        if (settingsOpen) {
            androidx.compose.ui.window.Dialog(onDismissRequest = { settingsOpen = false }) {
                SettingsDialog(
                    currentBaseUrl = state.baseUrl,
                    theme = theme,
                    appTheme = state.theme,
                    connecting = state.connecting,
                    onSave = { newUrl ->
                        onPair(newUrl)
                        settingsOpen = false
                    },
                    onClose = { settingsOpen = false }
                )
            }
        }
    }
}

/** 设置对话框：查看/修改连接地址并重新配对 */
@Composable
private fun SettingsDialog(
    currentBaseUrl: String,
    theme: ThemeColors,
    appTheme: AppTheme,
    connecting: Boolean,
    onSave: (String) -> Unit,
    onClose: () -> Unit
) {
    var url by remember { mutableStateOf(currentBaseUrl) }
    val accent = Themes.agentAccent(AgentId.ALL, appTheme)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(max = 620.dp)
            .verticalScroll(rememberScrollState())
            .clip(RoundedCornerShape(24.dp))
            .background(theme.bg)
            .padding(20.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "连接设置",
                color = theme.text, fontWeight = FontWeight.Bold, fontSize = 17.sp,
                modifier = Modifier.weight(1f)
            )
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(theme.card)
                    .clickableNoRipple(onClick = onClose),
                contentAlignment = Alignment.Center
            ) {
                Text("✕", color = theme.text2, fontSize = 13.sp)
            }
        }
        Spacer(Modifier.height(6.dp))
        Text("修改后会自动重新配对", color = theme.text3, fontSize = 12.sp)
        Spacer(Modifier.height(14.dp))
        Text("Mac 地址", color = theme.text2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        androidx.compose.material3.OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("https://your-mac.ts.net:17890", color = theme.text3, fontSize = 14.sp) },
            singleLine = true,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri),
            textStyle = androidx.compose.ui.text.TextStyle(color = theme.text, fontSize = 14.sp),
            shape = RoundedCornerShape(16.dp),
            colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                focusedBorderColor = accent,
                unfocusedBorderColor = Color.Transparent,
                cursorColor = accent,
                focusedContainerColor = theme.inputBg,
                unfocusedContainerColor = theme.inputBg
            )
        )
        Spacer(Modifier.height(16.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(if (connecting) theme.text3 else accent)
                .clickableNoRipple { if (url.isNotBlank() && !connecting) onSave(url.trim()) }
                .padding(vertical = 14.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(if (connecting) "重新连接中…" else "保存并重新连接", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        }
    }
}

/** 新建会话对话框（对齐 Switchyard：模型选择 + 思考模式 + 首条消息） */
@Composable
private fun NewSessionDialog(
    currentAgent: AgentId,
    models: List<ModelInfo>,
    theme: ThemeColors,
    appTheme: AppTheme,
    sending: Boolean,
    onConfirm: (String, String, String) -> Unit,
    onClose: () -> Unit
) {
    var prompt by remember { mutableStateOf("") }
    // 默认不选模型（空 = 用 daemon 默认模型）；用户点击下拉才选择。
    // grok/codex 的 ACP createSession 不接受 model 参数，传了会挂起/报错。
    var selectedModel by remember { mutableStateOf("") }
    var selectedEffort by remember { mutableStateOf("medium") }
    val accent = Themes.agentAccent(currentAgent, appTheme)
    val efforts = listOf("low", "medium", "high")
    val effortLabels = mapOf("low" to "低", "medium" to "中", "high" to "高")

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .clip(RoundedCornerShape(24.dp))
            .background(theme.bg)
            .padding(20.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "新建会话 · ${currentAgent.label}",
                color = theme.text, fontWeight = FontWeight.Bold, fontSize = 17.sp,
                modifier = Modifier.weight(1f)
            )
            Box(
                modifier = Modifier
                    .size(30.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(theme.card)
                    .clickableNoRipple(onClick = onClose),
                contentAlignment = Alignment.Center
            ) {
                Text("✕", color = theme.text2, fontSize = 13.sp)
            }
        }
        if (currentAgent == AgentId.ALL) {
            Spacer(Modifier.height(8.dp))
            Text("将使用默认 Agent（Grok）创建", color = Themes.approvalAmber, fontSize = 12.sp)
        }
        Spacer(Modifier.height(14.dp))

        // 模型选择
        Text("模型", color = theme.text2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(theme.inputBg)
                .clickableNoRipple {
                    // 模型下拉（简单循环选择）；空 = 默认模型
                    if (models.isNotEmpty()) {
                        if (selectedModel.isEmpty()) {
                            selectedModel = models.first().id
                        } else {
                            val idx = models.indexOfFirst { it.id == selectedModel }
                            selectedModel = models[(idx + 1) % models.size].id
                        }
                    }
                }
                .padding(horizontal = 14.dp, vertical = 11.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (selectedModel.isEmpty()) "默认模型"
                    else models.firstOrNull { it.id == selectedModel }?.name ?: "默认模型",
                    color = theme.text, fontSize = 13.sp, maxLines = 1,
                    modifier = Modifier.weight(1f)
                )
                Text("▾", color = theme.text3, fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(12.dp))

        // 思考模式
        Text("思考模式", color = theme.text2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(theme.inputBg)
                .clickableNoRipple {
                    val idx = efforts.indexOf(selectedEffort)
                    selectedEffort = efforts[(idx + 1) % efforts.size]
                }
                .padding(horizontal = 14.dp, vertical = 11.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    effortLabels[selectedEffort] ?: "中",
                    color = theme.text, fontSize = 13.sp,
                    modifier = Modifier.weight(1f)
                )
                Text("▾", color = theme.text3, fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(12.dp))

        // 首条消息输入
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(theme.inputBg)
                .padding(horizontal = 14.dp, vertical = 12.dp)
        ) {
            if (prompt.isEmpty()) {
                Text("输入第一条消息…", color = theme.text3, fontSize = 14.sp)
            }
            androidx.compose.foundation.text.BasicTextField(
                value = prompt,
                onValueChange = { prompt = it },
                textStyle = androidx.compose.ui.text.TextStyle(color = theme.text, fontSize = 14.sp),
                modifier = Modifier.fillMaxWidth().heightIn(min = 60.dp)
            )
        }
        Spacer(Modifier.height(16.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(if (sending) theme.text3 else accent)
                .clickableNoRipple {
                    if (prompt.isNotBlank() && !sending) onConfirm(prompt, selectedModel, selectedEffort)
                }
                .padding(vertical = 14.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(if (sending) "创建中…" else "创建会话", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
        }
    }
}
