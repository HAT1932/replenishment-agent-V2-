/**
 * mock.mjs — 确定性 Provider（离线测试 / 回放）
 * ---------------------------------------------------------------------------
 * 自测：node --test test/agent
 *
 * 与真实 Provider 走**同一套事件协议**：同样通过 onDelta 流式吐 reasoning/content，
 * 同样返回 {message:{role,content,reasoning_content,tool_calls}, usage}。
 * 特点：不联网、无随机、无系统时钟 —— 同一输入两次调用结果完全相同（可断言、可回放）。
 *
 * 默认剧本覆盖「巡店补货」主线：
 *   catalog.list_skus → inventory.get + suggestion.compute → order.create_draft
 *   →（人审批后）order.commit → 总结
 * 也支持自定义 script（数组或函数），用于构造其它测试场景（超时、死循环、DomainError…）。
 */

/** 默认的确定性用量（测试据此断言 usage 汇总） */
export const MOCK_USAGE = Object.freeze({ prompt_tokens: 100, completion_tokens: 20, reasoning_tokens: 5 });

const APPROVE_RE = /(批准|审批通过|通过|同意|提交|commit)/i;

function parseEnvelope(message) {
  if (!message || message.role !== 'tool') return null;
  try {
    return JSON.parse(message.content);
  } catch {
    return null;
  }
}

/** 取最近一次指定工具的完整结果（含 data/meta） */
function lastToolResult(messages, toolName) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'tool') continue;
    if (msg.name && msg.name !== toolName) continue;
    const envelope = parseEnvelope(msg);
    if (envelope) return envelope;
  }
  return null;
}

function findSuggestion(messages) {
  const result = lastToolResult(messages, 'suggestion.compute');
  const rows = result?.data?.rows ?? [];
  return rows.find((r) => Number(r.suggest_num) > 0) ?? rows[0] ?? null;
}

function firstSkuCode(messages) {
  const result = lastToolResult(messages, 'catalog.list_skus');
  return result?.data?.skus?.[0]?.sku_code ?? null;
}

/**
 * 默认剧本（纯函数：只读 messages）。
 * @param {{stepIndex:number, lastUserMessage:string, messages:Array<object>}} ctx
 */
export function defaultMockPlanner(ctx) {
  const { stepIndex, lastUserMessage, messages } = ctx;

  if (APPROVE_RE.test(lastUserMessage ?? '')) {
    if (stepIndex === 0) {
      const draft = lastToolResult(messages, 'order.create_draft');
      const draftId = draft?.data?.draft_id ?? null;
      const approvalId = draft?.meta?.approval?.id ?? draft?.data?.approval?.id ?? null;
      if (!draftId || !approvalId) {
        return {
          reasoning: '用户说要提交，但上下文里没有草稿/审批。',
          content: '没有找到可提交的草稿与审批，请先让我生成草稿并完成审批。',
        };
      }
      return {
        reasoning: `审批 ${approvalId} 已通过，调用 order.commit 提交草稿 ${draftId}。`,
        tool_calls: [{ name: 'order.commit', args: { draft_id: draftId, approval_id: approvalId } }],
      };
    }
    const commit = lastToolResult(messages, 'order.commit');
    return {
      reasoning: '提交完成，给用户一个结构化收尾。',
      content:
        `已提交正式单：${commit?.data?.biz_no ?? commit?.data?.order_id ?? '（见工具结果）'}。` +
        '本次操作已写入审计；建议下一步核对草稿明细与到货日。',
    };
  }

  switch (stepIndex) {
    case 0:
      return {
        reasoning: '先看有哪些 SKU，再决定取哪些数；任何数字都必须来自工具。',
        tool_calls: [{ name: 'catalog.list_skus', args: { limit: 5 } }],
      };
    case 1: {
      const sku = firstSkuCode(messages);
      if (!sku) {
        return { content: '没有查到可用 SKU，请先确认主数据是否已导入。' };
      }
      return {
        reasoning: '取该 SKU 的库存四层，并按默认方案算建议（计算走 domain，不自算）。',
        tool_calls: [
          { name: 'inventory.get', args: { sku_code: sku } },
          { name: 'suggestion.compute', args: { sku_codes: [sku], only_low: false } },
        ],
      };
    }
    case 2: {
      const row = findSuggestion(messages);
      if (!row) {
        return { content: '当前没有可补货的建议行，建议核对库存与安全库存配置。' };
      }
      const applyNum = Math.max(1, Number(row.apply_num ?? row.suggest_num ?? 0));
      return {
        reasoning: '建议已算出，生成草稿并请求人工审批（不能自动提交）。',
        tool_calls: [
          {
            name: 'order.create_draft',
            args: {
              kind: 'purchase',
              items: [{ sku_code: row.sku_code, apply_num: applyNum }],
              ...(row.expected_arrival ? { expected_arrival: row.expected_arrival } : {}),
              remark: 'mock provider 演示草稿',
            },
          },
        ],
      };
    }
    default: {
      const draft = lastToolResult(messages, 'order.create_draft');
      const approvalId = draft?.meta?.approval?.id ?? draft?.data?.approval?.id ?? null;
      return {
        reasoning: '草稿已生成，向人汇报并请求审批。',
        content:
          `已生成补货草稿 ${draft?.data?.draft_id ?? ''}：${draft?.data?.total_qty ?? 0} 件 / ` +
          `${draft?.data?.total_amount ?? 0} 元。审批 id：${approvalId ?? '（未返回）'}。\n\n` +
          '| 项目 | 值 | 来源 |\n|---|---|---|\n' +
          `| 建议数量 | ${draft?.data?.items?.[0]?.apply_num ?? 0} | suggestion.compute（documented，H1/H2/H4） |\n\n` +
          '请在审批卡上批准或驳回；批准后我才会调用 order.commit。',
      };
    }
  }
}

function splitChunks(text, size = 24) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/**
 * @param {{script?: Array<object|Function>|Function, usagePerCall?: object,
 *          name?: string, model?: string, delayMs?: number}} [opts]
 */
export function createMockProvider(opts = {}) {
  const usagePerCall = { ...MOCK_USAGE, ...(opts.usagePerCall ?? {}) };
  const provider = {
    name: opts.name ?? 'mock',
    model: opts.model ?? 'mock-deterministic',
    supportsStreaming: true,
    calls: [],
    /**
     * @param {{messages: Array<object>, tools?: Array<object>, signal?: AbortSignal,
     *          onDelta?: (d:{type:'reasoning'|'content', text:string}) => void}} input
     */
    async chat({ messages = [], signal, onDelta } = {}) {
      if (signal?.aborted) {
        const err = new Error('mock provider 已被取消');
        err.code = 'UPSTREAM_LLM_ERROR';
        throw err;
      }
      const callIndex = provider.calls.length;
      const assistantCount = countAssistantSinceLastUser(messages);
      const lastUserMessage = lastUserText(messages);
      const ctx = { stepIndex: assistantCount, lastUserMessage, messages, callIndex };
      let step;
      if (typeof opts.script === 'function') {
        step = await opts.script(ctx);
      } else if (Array.isArray(opts.script)) {
        const entry = opts.script[Math.min(assistantCount, opts.script.length - 1)];
        step = typeof entry === 'function' ? await entry(ctx) : entry;
      } else {
        step = defaultMockPlanner(ctx);
      }
      step = step ?? { content: '（mock 剧本已结束）' };

      const reasoning = step.reasoning ?? '';
      const content = step.content ?? '';
      const toolCalls = (step.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `mock_call_${callIndex + 1}_${index + 1}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.args ?? {}),
        },
      }));

      // 流式吐出：reasoning 与 content 分开，顺序稳定
      if (typeof onDelta === 'function') {
        for (const chunk of splitChunks(reasoning)) {
          if (signal?.aborted) break;
          onDelta({ type: 'reasoning', text: chunk });
        }
        for (const chunk of splitChunks(content)) {
          if (signal?.aborted) break;
          onDelta({ type: 'content', text: chunk });
        }
      }

      provider.calls.push({
        stepIndex: assistantCount,
        lastUserMessage,
        content,
        reasoning,
        tool_calls: toolCalls.map((c) => c.function.name),
      });

      return {
        message: {
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        usage: { ...usagePerCall },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      };
    },
  };
  return provider;
}

/** 统计最后一条 user 消息之后的 assistant 数量 = 本轮第几步 */
function countAssistantSinceLastUser(messages) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = messages[i]?.role;
    if (role === 'user') break;
    if (role === 'assistant') count += 1;
  }
  return count;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return String(messages[i].content ?? '');
  }
  return '';
}
