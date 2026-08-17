export const AUTH_TRACE_LOG_PREFIX = "[auth-trace]";

export const AUTH_TRACE_PROVIDERS = ["feishu", "github"] as const;
export type AuthTraceProvider = (typeof AUTH_TRACE_PROVIDERS)[number];

export const AUTH_TRACE_STAGES = [
  "oauth_started",
  "oauth_callback_received",
  "token_exchange_finished",
  "profile_validated",
  "identity_bound",
  "session_created",
  "rejected",
] as const;
export type AuthTraceStage = (typeof AUTH_TRACE_STAGES)[number];

export const AUTH_TRACE_OUTCOMES = ["started", "success", "failure", "rejected"] as const;
export type AuthTraceOutcome = (typeof AUTH_TRACE_OUTCOMES)[number];

export const AUTH_TRACE_REASON_CODES = [
  "oauth_state_invalid",
  "oauth_callback_invalid",
  "oauth_access_denied",
  "token_exchange_failed",
  "token_exchange_client_secret_invalid",
  "token_exchange_authorization_code_invalid",
  "token_exchange_user_not_authorized",
  "token_exchange_redirect_uri_mismatch",
  "profile_validation_failed",
  "identity_binding_failed",
  "identity_conflict",
  "session_creation_failed",
  "provider_unavailable",
] as const;
export type AuthTraceReasonCode = (typeof AUTH_TRACE_REASON_CODES)[number];

export type AuthTraceId = `auth_${string}`;

export type AuthTraceEvent = Readonly<{
  traceId: AuthTraceId;
  provider: AuthTraceProvider;
  stage: AuthTraceStage;
  outcome: AuthTraceOutcome;
  occurredAt: number;
  reasonCode?: AuthTraceReasonCode;
}>;

export type AuthTraceUuidGenerator = () => string;

export type AuthTraceLogger = {
  info: (prefix: string, event: AuthTraceEvent) => void;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_TRACE_ID_PATTERN =
  /^auth_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createAuthTraceId(
  randomUuid: AuthTraceUuidGenerator = () => crypto.randomUUID(),
): AuthTraceId {
  const uuid = randomUuid();
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error("Auth trace UUID generator returned an invalid UUID");
  }
  return `auth_${uuid}`;
}

export function logAuthTrace(logger: AuthTraceLogger, event: AuthTraceEvent): void {
  const safeEvent = toSafeAuthTraceEvent(event);
  logger.info(AUTH_TRACE_LOG_PREFIX, safeEvent);
}

function toSafeAuthTraceEvent(event: AuthTraceEvent): AuthTraceEvent {
  assertAuthTraceEvent(event);

  if (event.reasonCode === undefined) {
    return {
      traceId: event.traceId,
      provider: event.provider,
      stage: event.stage,
      outcome: event.outcome,
      occurredAt: event.occurredAt,
    };
  }

  return {
    traceId: event.traceId,
    provider: event.provider,
    stage: event.stage,
    outcome: event.outcome,
    occurredAt: event.occurredAt,
    reasonCode: event.reasonCode,
  };
}

function assertAuthTraceEvent(event: AuthTraceEvent): void {
  if (typeof event !== "object" || event === null) {
    throw new TypeError("Invalid auth trace event");
  }
  if (!isAuthTraceId(event.traceId)) {
    throw new TypeError("Invalid auth trace ID");
  }
  if (!isOneOf(AUTH_TRACE_PROVIDERS, event.provider)) {
    throw new TypeError("Invalid auth trace provider");
  }
  if (!isOneOf(AUTH_TRACE_STAGES, event.stage)) {
    throw new TypeError("Invalid auth trace stage");
  }
  if (!isOneOf(AUTH_TRACE_OUTCOMES, event.outcome)) {
    throw new TypeError("Invalid auth trace outcome");
  }
  if (typeof event.occurredAt !== "number" || !Number.isFinite(event.occurredAt)) {
    throw new TypeError("Invalid auth trace timestamp");
  }
  if (event.reasonCode !== undefined && !isOneOf(AUTH_TRACE_REASON_CODES, event.reasonCode)) {
    throw new TypeError("Invalid auth trace reason code");
  }
}

function isAuthTraceId(value: unknown): value is AuthTraceId {
  return typeof value === "string" && AUTH_TRACE_ID_PATTERN.test(value);
}

function isOneOf<const T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}
