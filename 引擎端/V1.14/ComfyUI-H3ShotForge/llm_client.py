"""V1.12 批 L (LLM 智能分镜) 波次 1 批次 B — T3 OpenAI 兼容 chat/completions 异步封装.

契约 (#50 行为 2 + 错误脱敏):
  - URL: base_url.rstrip('/') + '/chat/completions' (尾斜杠必剥, 防 //)
  - 超时: 默认 300s (参数化覆盖 — #60 批9 E3: 60→300·对齐 GUI 默认; 本地模型生成
    慢于 60s 时旧默认会被掐断)
  - 错误: 连接失败 / 超时 / 非 2xx / 合同错配一律抛 LLMCallError (error_code='llm_call_failed'),
          detail 严格脱敏 — 不含 api_key / Authorization 值 / 完整 base_url.
  - 无 key (空串/None/0) 时不带 Authorization 头; 真值时带 'Bearer <key>'.
  - 请求 body: {model, messages, max_tokens}; 解析返回 {content, finish_reason}
          (缺省 finish_reason='stop'; 合同错配 → LLMCallError).

调用路径:
  - 测试可注入 client= 已带 MockTransport 的 httpx.AsyncClient, 或
    _transport_for_test= 直接传 httpx.MockTransport (函数内自构临时 AsyncClient).
  - 生产路径: 不传 client / _transport_for_test → 函数自构 AsyncClient (trust_env=False
    防代理劫持, 与 h3_mcp/http_client 同款).
"""
import logging

import httpx


class LLMCallError(Exception):
    """llm_client 调用失败统一异常. error_code 固定 'llm_call_failed'."""
    
    def __init__(self, detail, error_code="llm_call_failed"):
        super().__init__(detail)
        self.error_code = error_code
        self.detail = detail


_DEFAULT_TIMEOUT = 300.0


async def llm_chat_completion(
    base_url,
    api_key,
    model,
    messages,
    max_tokens,
    *,
    timeout=_DEFAULT_TIMEOUT,
    client=None,
    _transport_for_test=None,
):
    """单轮 chat/completions 调用 → {'content': str, 'finish_reason': str}.

    失败统一抛 LLMCallError. 仅传 max_tokens 不足以保证不出窗 — #50 行为 5/6
    (输入裁剪/截断 warn) 在调用层 (后续 T5 handler) 处理, 本函数只做"一次合规 HTTP".
    """
    url = (base_url or "").rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    # 真值判定: 空串/None 一律不带 (header 缺失 vs 'Bearer ' 空头, 选前者更稳).
    if api_key:
        headers["Authorization"] = "Bearer " + str(api_key)
    body = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
    }

    # 错误 detail 模板只暴露 httpx 报错原文 (mock 路径已脱敏, 生产路径 httpx
    # 默认 message 含 'host:port' 字符串 — 故仅截到 200 字符截断防滥用).
    def _trim(s, n=200):
        s = (s or "").strip()
        return s if len(s) <= n else s[:n] + "..."

    if client is not None:
        _client = client
        _owns = False
    else:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            trust_env=False,
            transport=_transport_for_test,
        )
        _owns = True

    try:
        try:
            resp = await _client.post(url, headers=headers, json=body, timeout=timeout)
        except httpx.ConnectError as e:
            raise LLMCallError("connect_failed: " + _trim(str(e) or "无法连接")) from None
        except httpx.TimeoutException as e:
            raise LLMCallError("timeout: " + _trim(str(e) or "请求超时")) from None
        except httpx.HTTPError as e:
            raise LLMCallError(
                "http_error: " + type(e).__name__ + ": " + _trim(str(e) or "未知")
            ) from None

        status = resp.status_code
        if not (200 <= status < 300):
            # 截断 body 防 detail 失控; 服务端 body 也不应回显客户端 auth
            # (但即便回显了, 也只是 base64 噪声, 不暴露本地 key — 仍走截断).
            raise LLMCallError("http_%d: %s" % (status, _trim(resp.text, 500)))

        try:
            data = resp.json()
        except Exception as e:
            raise LLMCallError(
                "invalid_json_response: " + _trim(str(e) or "解析失败")
            ) from None

        choices = data.get("choices") if isinstance(data, dict) else None
        if not isinstance(choices, list) or not choices:
            # #65: 部分 OpenAI 兼容服务 (LM Studio) 对未知路径回 200 + {"error": ...},
            # 不带 choices — 透出服务端原文, 否则真实错因被 "missing choices" 吞掉.
            err = data.get("error") if isinstance(data, dict) else None
            if isinstance(err, dict):
                err = err.get("message") or err
            if err:
                raise LLMCallError(
                    "invalid_response: missing choices (服务端返回错误: %s)"
                    % _trim(str(err), 300)
                )
            raise LLMCallError("invalid_response: missing choices")
        first = choices[0]
        if not isinstance(first, dict):
            raise LLMCallError("invalid_response: choice is not dict")
        msg = first.get("message") or {}
        content = msg.get("content") or ""
        finish_reason = first.get("finish_reason") or "stop"
        return {"content": content, "finish_reason": finish_reason}
    finally:
        if _owns:
            try:
                await _client.aclose()
            except Exception:
                pass


# 抑制 httpx/httpcore 的 INFO 级日志 (与 h3_mcp/http_client 同款, 防 stderr 噪声)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
