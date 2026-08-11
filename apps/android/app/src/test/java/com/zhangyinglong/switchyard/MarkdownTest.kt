package com.zhangyinglong.switchyard

import com.zhangyinglong.switchyard.ui.Markdown
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {

    @Test
    fun `块解析 - 代码块围栏`() {
        val blocks = Markdown.parseBlocks("```kotlin\nval x = 1\nfun f() {}\n```")
        assertEquals(1, blocks.size)
        assertEquals(Markdown.BlockType.CODE, blocks[0].type)
        assertEquals("val x = 1\nfun f() {}", blocks[0].text)
    }

    @Test
    fun `块解析 - 标题`() {
        val blocks = Markdown.parseBlocks("# 大标题\n\n### 三级标题")
        assertEquals(2, blocks.size)
        assertEquals(Markdown.BlockType.HEADING, blocks[0].type)
        assertEquals(1, blocks[0].level)
        assertEquals("大标题", blocks[0].text)
        assertEquals(3, blocks[1].level)
        assertEquals("三级标题", blocks[1].text)
    }

    @Test
    fun `块解析 - 列表`() {
        val blocks = Markdown.parseBlocks("- 第一项\n- 第二项\n\n1. 编号一")
        assertEquals(3, blocks.size)
        assertEquals(Markdown.BlockType.BULLET, blocks[0].type)
        assertEquals("第一项", blocks[0].text)
        assertEquals(Markdown.BlockType.BULLET, blocks[1].type)
        assertEquals(Markdown.BlockType.NUMBERED, blocks[2].type)
        assertEquals("编号一", blocks[2].text)
    }

    @Test
    fun `块解析 - 引用`() {
        val blocks = Markdown.parseBlocks("> 引用内容")
        assertEquals(1, blocks.size)
        assertEquals(Markdown.BlockType.QUOTE, blocks[0].type)
        assertEquals("引用内容", blocks[0].text)
    }

    @Test
    fun `块解析 - 混合文本保留普通段落`() {
        val blocks = Markdown.parseBlocks("第一段\n\n第二段带**加粗**")
        assertEquals(2, blocks.size)
        assertEquals(Markdown.BlockType.TEXT, blocks[0].type)
        assertEquals("第一段", blocks[0].text)
        assertEquals(Markdown.BlockType.TEXT, blocks[1].type)
    }

    @Test
    fun `行内 token - 加粗斜体行内代码`() {
        val tokens = Markdown.inlineTokens("这是**加粗**和*斜体*和`代码`")
        assertEquals(6, tokens.size)
        // 这是 / **加粗** / 和 / *斜体* / 和 / `代码`
        assertEquals("这是", tokens[0].text)
        assertEquals(Markdown.InlineKind.BOLD, tokens[1].kind)
        assertEquals("加粗", tokens[1].text)
        assertEquals("和", tokens[2].text)
        assertEquals(Markdown.InlineKind.ITALIC, tokens[3].kind)
        assertEquals("斜体", tokens[3].text)
        assertEquals("和", tokens[4].text)
        assertEquals(Markdown.InlineKind.CODE, tokens[5].kind)
        assertEquals("代码", tokens[5].text)
    }

    @Test
    fun `行内 token - 纯文本无样式`() {
        val tokens = Markdown.inlineTokens("普通文本没有标记")
        assertEquals(1, tokens.size)
        assertEquals(null, tokens[0].kind)
        assertEquals("普通文本没有标记", tokens[0].text)
    }

    @Test
    fun `命令过滤 - 匹配 rename`() {
        val commands = listOf(
            Markdown.CommandCandidate("command:rename", "rename", "重命名会话", "/rename "),
            Markdown.CommandCandidate("command:model", "model", "查看或切换模型", "/model "),
            Markdown.CommandCandidate("command:clear", "clear", "清空当前会话", "/clear ")
        )
        val matched = Markdown.filterCommands("/re", commands)
        assertEquals(1, matched.size)
        assertEquals("rename", matched[0].name)
    }

    @Test
    fun `命令过滤 - 无匹配返回空`() {
        val commands = listOf(
            Markdown.CommandCandidate("command:model", "model", "查看或切换模型", "/model ")
        )
        val matched = Markdown.filterCommands("/zz", commands)
        assertTrue(matched.isEmpty())
    }

    @Test
    fun `命令过滤 - 空输入返回全部`() {
        val commands = listOf(
            Markdown.CommandCandidate("command:model", "model", "查看或切换模型", "/model "),
            Markdown.CommandCandidate("command:clear", "clear", "清空当前会话", "/clear ")
        )
        assertEquals(2, Markdown.filterCommands("/", commands).size)
        assertEquals(2, Markdown.filterCommands("", commands).size)
    }

    @Test
    fun `命令过滤 - 用 insertText 匹配`() {
        val commands = listOf(
            Markdown.CommandCandidate("command:rename", "rename", "重命名会话", "/rename ")
        )
        val matched = Markdown.filterCommands("/ren", commands)
        assertEquals(1, matched.size)
        assertEquals("rename", matched[0].name)
    }
}
