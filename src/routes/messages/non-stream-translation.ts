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

  // 1M model variants don't have effort-specific sub-variants (e.g. there is no
  // claude-opus-4.7-1m-internal-xhigh). Effort is conveyed via the
  // reasoning_effort parameter on the request body instead. Trigger this whenever
  // the resolved model is a 1M variant — regardless of how we got there.
  if (is1MVariant(resolvedModel) && options?.effort) {
    const mapped = mapEffortToReasoningEffort(options.effort)
    if (mapped) {
      result.reasoning_effort = mapped
    }
  }

  return result
}

/**
 * Map CC CLI effort levels to Copilot reasoning_effort values.
 * CC CLI exposes "max" in its UI but transparently maps it to "xhigh" before
 * sending. The "max" branch below is kept for defense / non-CC clients.
 * Copilot accepts: low, medium, high, xhigh
 */
function mapEffortToReasoningEffort(effort: string): string | undefined {
  switch (effort.toLowerCase()) {
    case "low": {
      return "low"
    }
    case "medium": {
      return "medium"
    }
    case "high": {
      return "high"
    }
    case "xhigh": {
      return "xhigh"
    }
    case "max": {
      return "xhigh"
    }
    default: {
      return undefined
    }
  }
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

  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === "user" ?
      handleUserMessage(message)
    : handleAssistantMessage(message),
  )

  return [...systemMessages, ...otherMessages]
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
        content: mapContent(message.content),
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

  // Combine text and thinking blocks, as OpenAI doesn't have separate thinking blocks
  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
  ].join("\n\n")

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
          content: mapContent(message.content),
        },
      ]
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
