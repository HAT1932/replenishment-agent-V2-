/**
 * sse.mjs — Server-Sent Events 写出器
 * ---------------------------------------------------------------------------
 * 契约（docs/contracts.md §5）：每行 `data: {json}\n\n`，同轮内 `seq` 单调递增。
 *
 * 关键行为：
 *  1) 响应头：`text/event-stream; charset=utf-8`（必须带 charset，中文才不会乱码）
 *     + `Cache-Control: no-cache` + `Connection: keep-alive` + `X-Accel-Buffering: no`
 *     （最后一个是反代不缓冲的约定，避免 nginx 把流攒成一坨）；
 *  2) 心跳：每 15s 一行注释 `: ping\n\n`（注释帧按 SSE 规范会被浏览器忽略，不污染 data 解析）；
 *  3) 客户端断开：`req.on('close')` / `res.on('close')` → `AbortController.abort()`，
 *     把 signal 交给 runtime，让模型调用与工具循环停下；
 *  4) 单条事件永远是「一行 data + 空行」——JSON.stringify 会把换行转义，所以天然单行，
 *     不要手工拼接多行 data（前端按 `data: ` 前缀 + 空行切分）。
 */

const HEARTBEAT_MS = 15_000;

/**
 * 建立一条 SSE 响应流。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ heartbeatMs?: number, onAbort?: (reason: { code: string, message: string }) => void }} [options]
 */
export function openSse(req, res, options = {}) {
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : HEARTBEAT_MS;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // 关掉 Node 的响应缓冲，保证每个 write 立刻落到 socket
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();

  const controller = new AbortController();
  /** 客户端断开/流已终结后禁止再写 */
  let stopped = false;
  let ended = false;
  /** 本地兜底序号：runtime 未给 seq 时补一个单调值 */
  let lastSeq = 0;
  let eventCount = 0;

  const write = (chunk) => {
    if (stopped || res.writableEnded || res.destroyed) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      hardStop('WRITE_FAILED', 'SSE 写入失败');
      return false;
    }
  };

  /** 立即发一帧注释，把响应头推给客户端（部分代理要见到字节才 flush） */
  write(': open\n\n');

  const heartbeat = setInterval(() => {
    write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();

  function clearHeartbeat() {
    clearInterval(heartbeat);
  }

  /** 标记停止并 abort（客户端主动断开 / 写失败） */
  function hardStop(code, message) {
    if (stopped) return;
    stopped = true;
    clearHeartbeat();
    const reason = { code, message };
    try {
      controller.abort(reason);
    } catch {
      controller.abort();
    }
    options.onAbort?.(reason);
  }

  const onClientClose = () => {
    if (ended) return;
    hardStop('CLIENT_DISCONNECTED', '客户端已断开连接');
  };
  req.on('close', onClientClose);
  res.on('close', onClientClose);
  // 客户端在写事件时报错（EPIPE 等）也要能停
  res.on('error', () => hardStop('CLIENT_DISCONNECTED', '连接异常中断'));

  /**
   * 发送一条事件。返回是否真的写出去了。
   * `seq` 缺省时用内部计数器补齐并回填到事件对象副本里（不改调用者对象）。
   * @param {Record<string, unknown>} event
   */
  function send(event) {
    if (stopped) return false;
    const payload = { ...event };
    const seq = Number.isInteger(payload.seq) ? payload.seq : lastSeq + 1;
    if (Number.isInteger(payload.seq)) lastSeq = Math.max(lastSeq, payload.seq);
    else lastSeq = seq;
    payload.seq = seq;
    // JSON.stringify 不会产生裸换行，天然满足「单行 data」
    const ok = write(`data: ${JSON.stringify(payload)}\n\n`);
    if (ok) eventCount += 1;
    return ok;
  }

  /** 发送注释帧（心跳/调试标记），不进 data 通道 */
  function comment(text) {
    return write(`: ${String(text).replace(/[\r\n]+/g, ' ')}\n\n`);
  }

  /** 正常收尾：关心跳 → 关连接 */
  function end() {
    if (ended) return;
    ended = true;
    stopped = true;
    clearHeartbeat();
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* 连接已断，忽略 */
    }
  }

  return {
    send,
    comment,
    end,
    /** 传给 runtime 的取消信号 */
    signal: controller.signal,
    /** 是否因客户端断开而中止 */
    get aborted() {
      return controller.signal.aborted;
    },
    /** 是否已停止写入（断开或 end） */
    get stopped() {
      return stopped;
    },
    get eventCount() {
      return eventCount;
    },
    get lastSeq() {
      return lastSeq;
    },
  };
}

export default { openSse, HEARTBEAT_MS };
