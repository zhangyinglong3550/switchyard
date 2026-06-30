import { contentToText } from '../../utils.mjs';

function targeted({ provider, model }) {
  const text = [
    provider?.id,
    provider?.name,
    provider?.baseUrl,
    model?.id,
    model?.providerId,
    model?.upstreamModel,
    model?.displayName,
    ...(model?.aliases || [])
  ].filter(Boolean).join(' ').toLowerCase();
  return text.includes('api.aigocode.app') || text.includes('aigo') || text.includes('中转gpt');
}

function flattenMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const next = { ...message };
  if (next.role !== 'tool') {
    next.content = contentToText(next.content || '');
  }
  if (Array.isArray(next.tool_calls)) {
    next.tool_calls = next.tool_calls.map((call) => {
      if (!call || typeof call !== 'object') return call;
      const fn = call.function || {};
      return {
        ...call,
        function: {
          ...fn,
          name: String(fn.name || call.name || 'tool').trim() || 'tool',
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
        }
      };
    });
  }
  if (next.role === 'assistant' && typeof next.content !== 'string') {
    next.content = contentToText(next.content || '');
  }
  return next;
}

export const aigoChatPatch = {
  id: 'aigo-chat',
  label: 'AIGo Chat 保守清洗',
  description: '针对 AIGoCode 这类 OpenAI Chat 中转，把 Claude Code 复杂消息压平为更保守的 Chat 请求形状。',
  trigger: 'provider/baseUrl 命中 api.aigocode.app 或 provider/model 名称包含 aigo/中转GPT。',
  changes: [
    '把非 tool message.content 压平成纯文本',
    '把 assistant tool_calls 的 function.arguments 规范为字符串 JSON',
    '降低复杂 content array/object 对上游中转的干扰'
  ],
  risk: '会牺牲部分富结构上下文表达力，但能提升严格中转对 Claude Code 请求的兼容性。',
  tests: [
    'aigo-chat · flattens message content for AIGo chat providers'
  ],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    return {
      ...body,
      messages: body.messages.map(flattenMessage)
    };
  }
};
