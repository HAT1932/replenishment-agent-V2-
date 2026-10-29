/**
 * errors.mjs — 域错误（带机器可读 code）
 * ---------------------------------------------------------------------------
 * 错误码与 HTTP 层映射见 docs/contracts.md §6：
 *   VALIDATION_ERROR → 400 / DATA_MISSING → 422 / STALE_DATA → 422
 * 设计原则：域层只抛「已分类」的错误，绝不抛裸 Error，避免 HTTP 层靠字符串猜。
 */

export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DATA_MISSING: 'DATA_MISSING',
  STALE_DATA: 'STALE_DATA',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  UPSTREAM_LLM_ERROR: 'UPSTREAM_LLM_ERROR',
  INTERNAL: 'INTERNAL',
});

export class DomainError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES} code
   * @param {string} message
   * @param {Record<string, any>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.code = ERROR_CODES[code] ? code : 'INTERNAL';
    this.details = details ?? undefined;
  }
}

export const validationError = (message, details) =>
  new DomainError('VALIDATION_ERROR', message, details);
export const dataMissing = (message, details) => new DomainError('DATA_MISSING', message, details);
export const staleData = (message, details) => new DomainError('STALE_DATA', message, details);

/** 把任意异常归一成 { code, message, details } —— HTTP 层唯一入口 */
export function toErrorEnvelope(err) {
  if (err instanceof DomainError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  return {
    code: 'INTERNAL',
    message: err instanceof Error ? err.message : String(err),
    details: undefined,
  };
}
