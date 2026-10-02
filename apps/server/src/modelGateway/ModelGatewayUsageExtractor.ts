/**
 * Model Gateway - reading token counts out of an upstream's own answer.
 *
 * The gateway forwards response bytes untouched, so usage can only be observed
 * by reading the same bytes the client receives. This module does that read
 * without ever holding on to anything but numbers: it is handed chunks, extracts
 * counts, and keeps no text.
 *
 * A field the upstream did not report stays `null`. That is the whole point of
 * the nullable columns: a locally tokenised guess presented as a measurement
 * would be worse than an honest blank, and "0 tokens" is a different fact from
 * "the upstream did not say".
 *
 * @module ModelGatewayUsageExtractor
 */
import type { ModelGatewayProtocol } from "@t3tools/contracts";

export interface ModelGatewayUsageTokens {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
}

interface MutableUsageTokens {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export const EMPTY_MODEL_GATEWAY_USAGE_TOKENS: ModelGatewayUsageTokens = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
};

/**
 * How much of a non-streaming body is buffered for parsing. A response larger
 * than this is still forwarded in full - only the usage read gives up, which
 * degrades to `null` rather than to a number nobody reported.
 */
const MAX_PARSE_BYTES = 8 * 1024 * 1024;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nestedRecord = (
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => asRecord(record?.[key]);

const readNumber = (record: Record<string, unknown> | undefined, key: string): number | null => {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** Later non-null readings win; a `null` never overwrites something that was reported. */
const merge = (
  tokens: MutableUsageTokens,
  key: keyof MutableUsageTokens,
  value: number | null,
): void => {
  if (value !== null) tokens[key] = value;
};

/**
 * Where a protocol puts `usage`, in the order the events arrive.
 *
 * Anthropic reports input on `message_start` and output on `message_delta`, so
 * both candidates are read out of every event and merged.
 */
const usageRecordsFor = (
  protocol: ModelGatewayProtocol,
  value: Record<string, unknown>,
): ReadonlyArray<Record<string, unknown> | undefined> => {
  switch (protocol) {
    case "openai-chat":
      return [asRecord(value.usage)];
    case "openai-responses":
      return [asRecord(value.usage), nestedRecord(asRecord(value.response), "usage")];
    case "anthropic-messages":
      return [nestedRecord(asRecord(value.message), "usage"), asRecord(value.usage)];
  }
};

const applyUsage = (
  tokens: MutableUsageTokens,
  protocol: ModelGatewayProtocol,
  usage: Record<string, unknown> | undefined,
): void => {
  if (usage === undefined) return;
  switch (protocol) {
    case "openai-chat":
      merge(tokens, "inputTokens", readNumber(usage, "prompt_tokens"));
      merge(tokens, "outputTokens", readNumber(usage, "completion_tokens"));
      merge(
        tokens,
        "cacheReadTokens",
        readNumber(nestedRecord(usage, "prompt_tokens_details"), "cached_tokens"),
      );
      return;
    case "openai-responses":
      merge(tokens, "inputTokens", readNumber(usage, "input_tokens"));
      merge(tokens, "outputTokens", readNumber(usage, "output_tokens"));
      merge(
        tokens,
        "cacheReadTokens",
        readNumber(nestedRecord(usage, "input_tokens_details"), "cached_tokens"),
      );
      merge(
        tokens,
        "reasoningTokens",
        readNumber(nestedRecord(usage, "output_tokens_details"), "reasoning_tokens"),
      );
      return;
    case "anthropic-messages":
      merge(tokens, "inputTokens", readNumber(usage, "input_tokens"));
      merge(tokens, "outputTokens", readNumber(usage, "output_tokens"));
      merge(tokens, "cacheReadTokens", readNumber(usage, "cache_read_input_tokens"));
      merge(tokens, "cacheWriteTokens", readNumber(usage, "cache_creation_input_tokens"));
      return;
  }
};

/** The JSON of one `data:` line, or undefined for a comment, a blank, or `[DONE]`. */
const ssePayload = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  return payload.length === 0 || payload === "[DONE]" ? undefined : payload;
};

export interface ModelGatewayUsageExtractor {
  /** Feed a chunk exactly as it is forwarded to the client. */
  readonly push: (chunk: Buffer) => void;
  /** The counts read so far; `null` where the upstream reported nothing. */
  readonly finish: () => ModelGatewayUsageTokens;
}

export const makeModelGatewayUsageExtractor = (
  protocol: ModelGatewayProtocol,
  options: { readonly streamed: boolean },
): ModelGatewayUsageExtractor => {
  const tokens: MutableUsageTokens = { ...EMPTY_MODEL_GATEWAY_USAGE_TOKENS };
  let pending = "";
  let abandoned = false;

  const applyJsonText = (text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A fragment we cannot parse tells us nothing; the counts stay as they are.
      return;
    }
    const record = asRecord(parsed);
    if (record === undefined) return;
    for (const usage of usageRecordsFor(protocol, record)) applyUsage(tokens, protocol, usage);
  };

  const push: ModelGatewayUsageExtractor["push"] = (chunk) => {
    if (abandoned) return;
    pending += chunk.toString("utf8");
    if (!options.streamed) {
      if (pending.length > MAX_PARSE_BYTES) {
        pending = "";
        abandoned = true;
      }
      return;
    }
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const payload = ssePayload(line);
      if (payload !== undefined) applyJsonText(payload);
    }
  };

  const finish: ModelGatewayUsageExtractor["finish"] = () => {
    if (!abandoned) {
      if (options.streamed) {
        const payload = ssePayload(pending);
        if (payload !== undefined) applyJsonText(payload);
      } else if (pending.length > 0) {
        applyJsonText(pending);
      }
    }
    return { ...tokens };
  };

  return { push, finish };
};
