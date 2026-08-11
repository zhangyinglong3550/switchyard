package com.zhangyinglong.switchyard

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.collectAsState
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.CreationExtras
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zhangyinglong.switchyard.net.ApiClient
import com.zhangyinglong.switchyard.notify.ConnectivityService
import com.zhangyinglong.switchyard.notify.NotificationHelper
import com.zhangyinglong.switchyard.security.TokenStore
import com.zhangyinglong.switchyard.ui.MainScreen
import com.zhangyinglong.switchyard.ui.MainViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        com.zhangyinglong.switchyard.util.CrashLogger.install(this)

        // Android 13+ 通知权限
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        NotificationHelper.ensureChannels(this)

        setContent {
            val viewModel: MainViewModel = viewModel(
                factory = MainViewModelFactory(ApiClient(), TokenStore(applicationContext))
            )
            val state = viewModel.state.collectAsState()
            // 配对成功后：订阅事件流 + 启动前台保活服务
            androidx.compose.runtime.LaunchedEffect(state.value.paired) {
                if (state.value.paired) {
                    viewModel.subscribeEvents()
                    ConnectivityService.start(this@MainActivity)
                }
            }
            // 相册选图（Photo Picker，无需权限）
            val scope = androidx.compose.runtime.rememberCoroutineScope()
            val imagePicker = androidx.activity.compose.rememberLauncherForActivityResult(
                androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia()
            ) { uri ->
                uri?.let {
                    scope.launch(Dispatchers.IO) {
                        try {
                            contentResolver.openInputStream(it)?.use { stream ->
                                val bytes = stream.readBytes()
                                val mime = contentResolver.getType(it) ?: "image/jpeg"
                                val name = "image-${System.currentTimeMillis()}.${mime.substringAfter("/")}"
                                val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                                viewModel.addImage(name, b64, mime)
                            }
                        } catch (_: Exception) {
                        }
                    }
                }
            }
            MainScreen(
                state = state.value,
                onPair = { url ->
                    viewModel.setBaseUrl(url)
                    viewModel.pair("Android-${Build.MODEL}")
                },
                onThemeChange = { viewModel.setTheme(it) },
                onPanelChange = { viewModel.switchPanel(it) },
                onOpen = { viewModel.openSession(it) },
                onBack = { viewModel.closeDetail() },
                onSend = { viewModel.sendMessage(it) },
                onDecide = { id, action -> viewModel.decideApproval(id, action) },
                onOpenModelSheet = { viewModel.openModelSheet() },
                onCloseModelSheet = { viewModel.closeModelSheet() },
                onSetModel = { viewModel.setModel(it) },
                onPickImage = {
                    imagePicker.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                onRemoveImage = { viewModel.removeImage(it) },
                onNewSession = { viewModel.openNewSessionDialog() },
                onCloseNewSession = { viewModel.closeNewSessionDialog() },
                onCreateSession = { prompt, model, effort -> viewModel.createSession(prompt, model, effort) }
            )
        }
    }
}

private class MainViewModelFactory(
    private val api: ApiClient,
    private val store: TokenStore
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T {
        return MainViewModel(api, store) as T
    }
}
