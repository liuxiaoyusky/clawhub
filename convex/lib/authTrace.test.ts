/* @vitest-environment node */

import { describe, expect, it, vi } from "vitest";
import {
  AUTH_TRACE_LOG_PREFIX,
  createAuthTraceId,
  logAuthTrace,
  type AuthTraceEvent,
} from "./authTrace";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const TRACE_ID = `auth_${UUID}` as const;

describe("authTrace", () => {
  it("creates a predictable opaque ID with an injected UUID generator", () => {
    expect(createAuthTraceId(() => UUID)).toBe(TRACE_ID);
    expect(createAuthTraceId(() => UUID)).toMatch(
      /^auth_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("rejects a non-UUID injected value", () => {
    expect(() => createAuthTraceId(() => "not-a-uuid")).toThrow(
      "Auth trace UUID generator returned an invalid UUID",
    );
  });

  it("logs exactly the allowlisted event fields", () => {
    const logger = { info: vi.fn() };
    const event = {
      traceId: TRACE_ID,
      provider: "feishu",
      stage: "token_exchange_finished",
      outcome: "failure",
      occurredAt: 1_725_000_000_000,
      reasonCode: "token_exchange_failed",
    } satisfies AuthTraceEvent;
    const eventWithUnexpectedField = {
      ...event,
      unexpectedField: { ignored: true },
    } as AuthTraceEvent;

    logAuthTrace(logger, eventWithUnexpectedField);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(AUTH_TRACE_LOG_PREFIX, event);
    expect(Object.keys(logger.info.mock.calls[0]?.[1] ?? {})).toEqual([
      "traceId",
      "provider",
      "stage",
      "outcome",
      "occurredAt",
      "reasonCode",
    ]);
  });

  it.each([
    { provider: "feishu", stage: "oauth_started", outcome: "started" },
    { provider: "feishu", stage: "oauth_callback_received", outcome: "success" },
    {
      provider: "github",
      stage: "token_exchange_finished",
      outcome: "failure",
      reasonCode: "token_exchange_failed",
    },
    { provider: "github", stage: "profile_validated", outcome: "success" },
    { provider: "feishu", stage: "identity_bound", outcome: "success" },
    { provider: "github", stage: "session_created", outcome: "success" },
    {
      provider: "feishu",
      stage: "rejected",
      outcome: "rejected",
      reasonCode: "oauth_callback_invalid",
    },
  ] as const)("records a legal $provider/$stage/$outcome event", (details) => {
    const logger = { info: vi.fn() };
    const event = {
      traceId: TRACE_ID,
      ...details,
      occurredAt: 0,
    } satisfies AuthTraceEvent;

    expect(() => logAuthTrace(logger, event)).not.toThrow();
    expect(logger.info).toHaveBeenCalledWith(AUTH_TRACE_LOG_PREFIX, event);
  });
});
