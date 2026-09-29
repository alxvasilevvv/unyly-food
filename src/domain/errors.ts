// Machine-readable domain errors shared by MCP tools and the web UI.
export const ErrorCodes = {
  AUTH_REQUIRED: 401,
  INSUFFICIENT_SCOPE: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CAPABILITY_UNAVAILABLE: 409,
  ADDRESS_REQUIRED: 409,
  ADDRESS_AMBIGUOUS: 409,
  DELIVERY_UNAVAILABLE: 409,
  RESTAURANT_CLOSED: 409,
  ITEM_NOT_FOUND: 404,
  OUT_OF_STOCK: 409,
  MODIFIERS_INVALID: 400,
  MINIMUM_ORDER_NOT_MET: 409,
  CART_VERSION_CONFLICT: 409,
  CART_NOT_OPEN: 409,
  CART_EMPTY: 409,
  QUOTE_REQUIRED: 409,
  QUOTE_EXPIRED: 409,
  PRICE_CHANGED: 409,
  CONFIRMATION_REQUIRED: 409,
  CONFIRMATION_EXPIRED: 409,
  CONFIRMATION_INVALIDATED: 409,
  SUBMISSIONS_PAUSED: 503,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_REJECTED: 422,
  SUBMISSION_UNKNOWN: 202,
  CANCELLATION_NOT_ALLOWED: 409,
  CANCELLATION_UNKNOWN: 202,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly userAction?: string;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, userAction?: string) {
    super(message);
    this.code = code;
    this.details = details;
    this.userAction = userAction;
  }
  get httpStatus(): number {
    return ErrorCodes[this.code];
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError;
