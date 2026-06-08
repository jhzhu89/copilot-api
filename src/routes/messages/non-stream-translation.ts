import { state } from "~/lib/state"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  options?: { wants1M?: boolean; effort?: string },
): ChatCompletionsPayload {
  // wants1M is intentionally ignored here — translateModelName now decides
  // 1M routing solely based on what Copilot advertises. The option is kept in
  // the signature for backwards compatibility with callers that still pass it.
  void options?.wants1M

  const resolvedModel = translateModelName(payload.model)

  const result: ChatCompletionsPayload = {
    model: resolvedModel,
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system,
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
  }

  if (payload.thinking) {
    result.thinking = {
      type:
        payload.thinking.type === "adaptive" ?
          "enabled"
        : payload.thinking.type,
      budget_tokens: payload.thinking.budget_tokens,
    }
  }

  // Convey effort via the reasoning_effort parameter whenever the resolved
  // model advertises a multi-value reasoning_effort list (covers all 1M
  // variants, claude-opus-4.8, claude-sonnet-4.6, etc). Effort-locked variants
  // like claude-opus-4.7-xhigh advertise a single-value list and are skipped —
  // their effort is baked into the model id. When the model isn't in the
  // cached list, fall back to the legacy 1M-suffix heuristic so we don't
  // silently drop effort for unknown models.
  if (options?.effort) {
    const mapped = mapEffortToReasoningEffort(resolvedModel, options.effort)
    if (mapped) {
      result.reasoning_effort = mapped
    }
  }

  return result
}

/**
 * Map CC CLI effort levels to a Copilot reasoning_effort value the resolved
 * model actually accepts. Returns undefined when the model doesn't support
 * runtime effort selection (single-value or absent supports.reasoning_effort
 * list, and not a known 1M variant).
 *
 * The 5-level ladder Copilot exposes for newer models is:
 *   low < medium < high < xhigh < max
 * CC CLI's "max" used to be a UI alias for "xhigh"; Copilot now accepts "max"
 * as a real value on models that advertise it (opus-4.8, opus-4.7, etc).
 */
function mapEffortToReasoningEffort(
  resolvedModel: string,
  effort: string,
): string | undefined {
  const normalized = effort.toLowerCase()

  const supported = getSupportedEfforts(resolvedModel)
  if (!supported) {
    // Unknown model: legacy behavior — only honor effort for 1M variants and
    // collapse "max" to "xhigh" (the safe pre-4.8 ceiling).
    if (!is1MVariant(resolvedModel)) return undefined
    return normalized === "max" ? "xhigh" : passthroughEffort(normalized)
  }

  // Effort-locked variants (single-value list) bake effort into the id; don't
  // override it.
  if (supported.length <= 1) return undefined

  // Walk the requested level down to the highest available the model accepts.
  // Order matters: a user asking for "max" on a model that tops out at "xhigh"
  // should land on "xhigh", not silently drop.
  const fallbackChain = effortFallbackChain(normalized)
  for (const candidate of fallbackChain) {
    if (supported.includes(candidate)) return candidate
  }
  return undefined
}

function passthroughEffort(effort: string): string | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max": {
      return effort
    }
    default: {
      return undefined
    }
  }
}

function effortFallbackChain(effort: string): Array<string> {
  switch (effort) {
    case "max": {
      return ["max", "xhigh", "high", "medium", "low"]
    }
    case "xhigh": {
      return ["xhigh", "high", "medium", "low"]
    }
    case "high": {
      return ["high", "medium", "low"]
    }
    case "medium": {
      return ["medium", "low"]
    }
    case "low": {
      return ["low"]
    }
    default: {
      return []
    }
  }
}

function getSupportedEfforts(model: string): Array<string> | undefined {
  const entry = state.models?.data.find((m) => m.id === model)
  return entry?.capabilities.supports?.reasoning_effort
}

const ONE_M_SUFFIX_RE = /-1m(?:-internal)?$/

function is1MVariant(model: string): boolean {
  return ONE_M_SUFFIX_RE.test(model)
}

/**
 * Translate Anthropic/Claude model names to the format expected by Copilot
 * backend.
 *
 * Resolution rules (in order):
 *   1. Normalize input format: strip [1m] suffix, convert dash-major-minor to
 *      dotted form (claude-opus-4-7 → claude-opus-4.7), drop date suffixes.
 *   2. If the normalized name is already a 1M variant (-1m or -1m-internal),
 *      keep it as-is.
 *   3. If the Copilot model list advertises a 1M variant for this base model,
 *      always route to it. CC CLI no longer sends a 1M signal for newer models
 *      (e.g. claude-opus-4.7), so we cannot rely on header detection — we
 *      simply prefer the larger context window whenever it's available.
 *   4. Otherwise return the base model.
 *
 * Effort-specific 200K variants (claude-opus-4.7-high / -xhigh) are intentionally
 * never produced here — once a base model has a 1M variant, we always route to
 * 1M and rely on the reasoning_effort parameter to convey effort.
 */
export function translateModelName(model: string): string {
  const hasBracketSuffix = model.endsWith("[1m]")
  const stripped = hasBracketSuffix ? model.slice(0, -4) : model

  const normalized = normalizeToDottedForm(stripped)

  // Already a 1M variant — keep as-is.
  if (is1MVariant(normalized)) {
    return normalized
  }

  // Strip any -1m suffix first (defensive: stale config could feed us one).
  const base = normalized.replace(ONE_M_SUFFIX_RE, "")

  // Always prefer the 1M variant when Copilot advertises one.
  const oneMVariant = find1MVariant(base)
  if (oneMVariant) {
    return oneMVariant
  }

  return base
}

/**
 * Convert input model name to Copilot's dotted format, stripping date suffixes.
 *   claude-opus-4-7              → claude-opus-4.7
 *   claude-opus-4-6-20260101     → claude-opus-4.6
 *   claude-opus-4.6              → claude-opus-4.6 (passthrough)
 *   claude-sonnet-4-20250514     → claude-sonnet-4 (date-only suffix)
 *   gpt-4o                       → gpt-4o (passthrough)
 */
function normalizeToDottedForm(name: string): string {
  if (/\.\d/.test(name)) {
    // Already in dotted format
    return name
  }

  // Try: claude-{family}-{major}-{minor}[-date][-suffix]
  const m = name.match(
    /^(claude-(?:opus|sonnet|haiku)-\d+)-(\d{1,2})(?:-\d{6,})?(-.*)?$/,
  )
  if (m) {
    return `${m[1]}.${m[2]}${m[3] || ""}`
  }

  // Try: claude-{family}-{major}-{date} (no minor version)
  const m2 = name.match(/^(claude-(?:opus|sonnet|haiku)-\d+)-\d{6,}$/)
  return m2 ? m2[1] : name
}

/**
 * Look up a 1M variant for the given base model in the Copilot model list.
 * Prefers `-1m` over `-1m-internal` when both exist. Returns undefined if no
 * 1M variant is advertised or the model list is not loaded.
 */
function find1MVariant(base: string): string | undefined {
  for (const suffix of ["-1m", "-1m-internal"]) {
    const candidate = base + suffix
    if (state.models?.data.some((m) => m.id === candidate)) {
      return candidate
    }
  }
  return undefined
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  // CC CLI sometimes injects `role: "system"` items into the messages array
  // (e.g. <system-reminder> nudges that arrive mid-conversation). The Anthropic
  // Messages API technically only allows user/assistant in the array, but we
  // need to handle this real-world payload shape. Dropping these messages or
  // routing them into the assistant branch is harmful — when such a message
  // ends up last, the resulting OpenAI payload has a trailing assistant turn,
  // which the upstream rejects with "This model does not support assistant
  // message prefill". OpenAI/Copilot accept mid-stream `role: "system"`
  // messages natively, so we pass them through.
  const otherMessages = anthropicMessages.flatMap((message) => {
    // Cast to widen the role union — real-world payloads include "system" and
    // potentially other roles that aren't in the AnthropicMessage type.
    const role = (message as { role: string }).role
    if (role === "user")
      return handleUserMessage(message as AnthropicUserMessage)
    if (role === "assistant")
      return handleAssistantMessage(message as AnthropicAssistantMessage)
    // role === "system" (or any other unexpected role from non-conforming
    // clients): wrap as an OpenAI system message. mapContent handles both
    // string and structured-block content, mirroring how user/assistant
    // messages are normalized.
    return handleInlineSystemMessage(
      message as { role: string; content: unknown },
    )
  })

  return [...systemMessages, ...otherMessages]
}

function handleInlineSystemMessage(message: {
  role: string
  content: unknown
}): Array<Message> {
  // mapContent expects the AnthropicUserContentBlock | AnthropicAssistantContentBlock
  // union; system messages from CC CLI carry either a plain string or simple
  // text blocks (same shape as user text), so we reuse mapContent and coerce.
  const mapped = mapContent(
    message.content as
      | string
      | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
  )
  // OpenAI system message content must be string or null (not a parts array).
  // If the mapped result is a parts array (e.g. image present — vanishingly
  // unlikely for a system reminder), flatten its text parts.
  let content: string | null
  if (typeof mapped === "string") {
    content = mapped
  } else if (Array.isArray(mapped)) {
    content = mapped
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n\n")
  } else {
    content = mapped
  }
  return content === null ? [] : [{ role: "system", content }]
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: rtrimAssistantText(mapContent(message.content)),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )

  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  // Combine text and thinking blocks, as OpenAI doesn't have separate thinking blocks.
  // Trim trailing whitespace: when this turn becomes the final assistant message
  // (assistant prefill mode), Anthropic upstream rejects trailing whitespace with
  // 400 "messages: final assistant content cannot end with trailing whitespace".
  // Thinking blocks frequently end with "\n" or " ", so the join+rtrim is required
  // to keep CC CLI's history replay working on opus-4.6 / 4.7 / 4.8.
  const allTextContent = rtrimAssistantText(
    [
      ...textBlocks.map((b) => b.text),
      ...thinkingBlocks.map((b) => b.thinking),
    ].join("\n\n"),
  )

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [
        {
          role: "assistant",
          content: rtrimAssistantText(mapContent(message.content)),
        },
      ]
}

/**
 * Anthropic upstream (proxied through Copilot) rejects assistant messages whose
 * content ends with whitespace when the assistant turn is the final message.
 * We can't always tell at translation time whether a given assistant turn will
 * end up being the final one (CC CLI replays history in many shapes), so we
 * unconditionally rtrim assistant text. This is always safe — the upstream
 * never wants trailing whitespace, and dropping it never changes meaning.
 */
function rtrimAssistantText<T extends string | Array<ContentPart> | null>(
  content: T,
): T {
  if (typeof content === "string") {
    return content.replace(/\s+$/u, "") as T
  }
  if (Array.isArray(content)) {
    // Trim the last text part only — earlier whitespace is part of the
    // structured content and may be load-bearing. Map preserves the array
    // shape; we only rewrite the last text part we find.
    const lastTextIdx = content.findLastIndex((part) => part.type === "text")
    if (lastTextIdx === -1) return content
    const trimmed: Array<ContentPart> = content.map((part, i) => {
      if (i !== lastTextIdx || part.type !== "text") return part
      return { type: "text", text: part.text.replace(/\s+$/u, "") }
    })
    return trimmed as T
  }
  return content
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
          block.type === "text" || block.type === "thinking",
      )
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })

        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })

        break
      }
      // No default
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
): AnthropicResponse {
  // Merge content from all choices
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
    null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Process all choices to extract text and tool use blocks
  for (const choice of response.choices) {
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  // Note: GitHub Copilot doesn't generate thinking blocks, so we don't include them in responses

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.function.name,
    input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
  }))
}
