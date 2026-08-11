package com.zhangyinglong.switchyard.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zhangyinglong.switchyard.ui.theme.ThemeColors
import com.zhangyinglong.switchyard.ui.theme.Themes

/**
 * Markdown 渲染：块解析 + 行内样式解析是纯逻辑（可 JUnit 直接测试），
 * Compose 渲染层只消费解析结果。
 */
object Markdown {
    private val HEADING = Regex("^(#{1,6})\\s+(.*)$")
    private val BULLET = Regex("^\\s*[-*+]\\s+(.*)$")
    private val NUMBERED = Regex("^\\s*\\d+\\.\\s+(.*)$")
    private val QUOTE = Regex("^\\s*>\\s?(.*)$")
    private val FENCE = Regex("^\\s*```(\\w*)")
    private val INLINE = Regex("(\\*\\*([^*]+?)\\*\\*)|(\\*([^*]+?)\\*)|(`([^`]+?)`)")

    /** 块类型 */
    enum class BlockType { TEXT, CODE, HEADING, BULLET, NUMBERED, QUOTE }

    /** 解析后的块 */
    data class Block(
        val text: String,
        val type: BlockType = BlockType.TEXT,
        val level: Int = 0
    )

    /** 行内 token 类型 */
    enum class InlineKind { BOLD, ITALIC, CODE }

    /** 行内 token：plain 为原样文本，styled 为被标记包裹的文本 */
    data class InlineToken(val text: String, val kind: InlineKind? = null)

    /**
     * 把 markdown 文本切成块（纯逻辑，无 Android 依赖）。
     * 支持：代码块围栏、标题、无序/有序列表、引用、普通段落。
     */
    fun parseBlocks(markdown: String): List<Block> {
        val blocks = mutableListOf<Block>()
        val lines = markdown.split("\n")
        var i = 0

        while (i < lines.size) {
            val line = lines[i]
            if (FENCE.containsMatchIn(line)) {
                i++
                val code = StringBuilder()
                while (i < lines.size && !FENCE.containsMatchIn(lines[i])) {
                    code.appendLine(lines[i])
                    i++
                }
                i++ // 跳过闭合围栏
                if (code.isNotEmpty()) blocks.add(Block(code.toString().trimEnd('\n'), BlockType.CODE))
                continue
            }
            if (line.isBlank()) { i++; continue }
            val h = HEADING.matchEntire(line.trim())
            if (h != null) {
                blocks.add(Block(h.groupValues[2], BlockType.HEADING, h.groupValues[1].length))
                i++; continue
            }
            val b = BULLET.matchEntire(line)
            if (b != null) { blocks.add(Block(b.groupValues[1], BlockType.BULLET)); i++; continue }
            val n = NUMBERED.matchEntire(line)
            if (n != null) { blocks.add(Block(n.groupValues[1], BlockType.NUMBERED)); i++; continue }
            val q = QUOTE.matchEntire(line)
            if (q != null) { blocks.add(Block(q.groupValues[1], BlockType.QUOTE)); i++; continue }
            blocks.add(Block(line, BlockType.TEXT))
            i++
        }
        return blocks
    }

    /**
     * 行内样式 token 化（纯逻辑）：把 `**bold**`、`*italic*`、`` `code` `` 拆成 token 序列。
     * 返回的列表按原始顺序排列，styled 段带 kind，plain 段 kind 为 null。
     */
    fun inlineTokens(text: String): List<InlineToken> {
        val tokens = mutableListOf<InlineToken>()
        var p = 0
        INLINE.findAll(text).forEach { m ->
            if (m.range.first > p) tokens.add(InlineToken(text.substring(p, m.range.first)))
            val g1 = m.groupValues[2]; val g2 = m.groupValues[4]; val g3 = m.groupValues[6]
            when {
                g1.isNotEmpty() -> tokens.add(InlineToken(g1, InlineKind.BOLD))
                g2.isNotEmpty() -> tokens.add(InlineToken(g2, InlineKind.ITALIC))
                g3.isNotEmpty() -> tokens.add(InlineToken(g3, InlineKind.CODE))
            }
            p = m.range.last + 1
        }
        if (p < text.length) tokens.add(InlineToken(text.substring(p)))
        return tokens
    }

    /** 命令过滤（纯逻辑）：输入文本 + 命令列表 → 匹配候选。无匹配返回空列表。 */
    data class CommandCandidate(val id: String, val name: String, val description: String, val insertText: String)

    fun filterCommands(input: String, commands: List<CommandCandidate>): List<CommandCandidate> {
        val q = input.trim().removePrefix("/").lowercase()
        if (q.isEmpty()) return commands
        return commands.filter {
            it.name.lowercase().contains(q) || it.insertText.removePrefix("/").lowercase().contains(q)
        }
    }
}

/** 渲染一个 markdown 文本块序列 */
@Composable
fun MarkdownBody(markdown: String, theme: ThemeColors, modifier: Modifier = Modifier) {
    val blocks = Markdown.parseBlocks(markdown)
    Column(modifier = modifier.fillMaxWidth()) {
        blocks.forEach { block ->
            when (block.type) {
                Markdown.BlockType.CODE -> {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp)
                            .background(theme.toolBg, RoundedCornerShape(10.dp))
                            .padding(horizontal = 10.dp, vertical = 8.dp)
                    ) {
                        Text(
                            block.text,
                            color = theme.text2,
                            fontSize = 11.5.sp,
                            fontFamily = FontFamily.Monospace,
                            lineHeight = 17.sp
                        )
                    }
                }
                Markdown.BlockType.HEADING -> {
                    Text(
                        markdownInline(block.text, theme.text, Themes.diffAdd),
                        color = theme.text,
                        fontSize = when {
                            block.level <= 2 -> 17.sp
                            block.level <= 4 -> 15.sp
                            else -> 14.sp
                        },
                        fontWeight = FontWeight.Bold,
                        lineHeight = 22.sp,
                        modifier = Modifier.padding(top = 6.dp, bottom = 2.dp)
                    )
                }
                Markdown.BlockType.BULLET, Markdown.BlockType.NUMBERED -> {
                    Row(modifier = Modifier.padding(start = 8.dp, top = 1.dp, bottom = 1.dp)) {
                        Text("• ", color = theme.text2, fontSize = 13.sp, lineHeight = 20.sp)
                        Text(
                            markdownInline(block.text, theme.text, Themes.diffAdd),
                            color = theme.text,
                            fontSize = 13.sp,
                            lineHeight = 20.sp
                        )
                    }
                }
                Markdown.BlockType.QUOTE -> {
                    Row(modifier = Modifier.padding(vertical = 2.dp)) {
                        Box(
                            modifier = Modifier
                                .width(3.dp)
                                .height(IntrinsicSize.Min)
                                .background(theme.text3, RoundedCornerShape(2.dp))
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            markdownInline(block.text, theme.text2, Themes.diffAdd),
                            color = theme.text2,
                            fontSize = 13.sp,
                            fontStyle = FontStyle.Italic,
                            lineHeight = 20.sp
                        )
                    }
                }
                else -> {
                    Text(
                        markdownInline(block.text, theme.text, Themes.diffAdd),
                        color = theme.text,
                        fontSize = 13.sp,
                        lineHeight = 20.sp
                    )
                }
            }
            Spacer(Modifier.height(2.dp))
        }
    }
}

/** 行内 markdown → AnnotatedString（Compose 渲染用，非 Composable） */
fun markdownInline(text: String, baseColor: Color, codeColor: Color): AnnotatedString =
    buildAnnotatedString {
        Markdown.inlineTokens(text).forEach { token ->
            val kind = token.kind
            when (kind) {
                Markdown.InlineKind.BOLD -> withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = baseColor)) { append(token.text) }
                Markdown.InlineKind.ITALIC -> withStyle(SpanStyle(fontStyle = FontStyle.Italic, color = baseColor)) { append(token.text) }
                Markdown.InlineKind.CODE -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = codeColor, background = codeColor.copy(alpha = 0.15f))) { append(token.text) }
                null -> withStyle(SpanStyle(color = baseColor)) { append(token.text) }
            }
        }
    }
