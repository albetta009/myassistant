// LLM 层：任意 OpenAI 兼容端点，流式 SSE 解析，支持 abort / 用量回传。
// 零依赖：node:fetch + ReadableStream。
import { logger } from './log.js';
const log = logger('llm');

function buildUrl(baseUrl) {
  if (/\/chat\/completions$/.test(baseUrl)) return baseUrl;
  return baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

/**
 * 流式请求。yield {type:'delta'|'reasoning'|'usage', ...}
 * @param {{provider:{baseUrl:string,apiKey:string,headers?:object}, model:string,
 *          messages:Array, temperature?:number, maxTokens?:number, signal?:AbortSignal}} opts
 */
export async function* streamChat({ provider, model, messages, temperature, maxTokens, signal }) {
  if (!provider?.baseUrl) throw new Error('provider.baseUrl 缺失');
  if (!provider.apiKey && !provider.noAuth && !Object.keys(provider.headers || {}).length) {
    throw new Error(`provider「${provider.name}」没有 api key（config/secrets.json 里补）`);
  }
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;

  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider.headers || {}),
  };

  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(buildUrl(provider.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    throw new Error(`请求 ${provider.baseUrl} 失败: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hint = res.status === 401 ? '（api key 无效或过期）' : '';
    throw new Error(`LLM HTTP ${res.status}${hint}: ${text.slice(0, 600)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let sawAny = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
        for (const rawLine of chunk.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          let j;
          try {
            j = JSON.parse(payload);
          } catch {
            continue;
          }
          const d = j.choices?.[0]?.delta || {};
          if (d.reasoning_content) yield { type: 'reasoning', text: d.reasoning_content };
          if (typeof d.content === 'string' && d.content.length) {
            sawAny = true;
            yield { type: 'delta', text: d.content };
          }
          if (j.usage) yield { type: 'usage', usage: j.usage };
          if (j.choices?.[0]?.finish_reason) yield { type: 'finish', reason: j.choices[0].finish_reason };
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    const ms = Date.now() - startedAt;
    if (sawAny) log.debug(`流结束 ${ms}ms`);
  }
}

/**
 * 非流式便捷封装：返回纯文本。
 * allowReasoningFallback：推理模型把预算耗在 reasoning_content、正文为空时，退回推理内容
 * （只有像心情判断这种「格式宽松、能自己抽 JSON」的调用才该打开，否则会拿到一堆思考过程的散文）
 */
export async function complete({ provider, model, messages, temperature, maxTokens, signal, allowReasoningFallback = false }) {
  let out = '';
  let reasoning = '';
  for await (const ev of streamChat({ provider, model, messages, temperature, maxTokens, signal })) {
    if (ev.type === 'delta') out += ev.text;
    else if (ev.type === 'reasoning') reasoning += ev.text;
  }
  const text = out.trim();
  if (text) return text;
  return allowReasoningFallback ? reasoning.trim() : '';
}

/** 粗估 token（中文 ~1.6 字符/token，英文 ~4 字符/token），用于预算护栏 */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 3.6);
}
