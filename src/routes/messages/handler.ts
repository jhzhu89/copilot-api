import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

  if (anthropicPayload.thinking?.type === "adaptive") {
    anthropicPayload.thinking.type = "enabled"
  }

  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // Detect whether the client requested 1M context via the anthropic-beta header.
  // CC CLI sends e.g. "context-1m-2025-08-07" for older models like opus-4.6.
  // Newer models (opus-4.7) no longer use this header — translateModelName
  // routes them to the 1M variant unconditionally based on the model list.
  const betaHeader =
    c.req.header("anthropic-beta") ?? c.req.header("Anthropic-Beta") ?? ""
  const wants1M = /(?:^|,)\s*context-1m-/i.test(betaHeader)

  // Extract effort level from output_config.effort (CC CLI sends this)
  const effort = anthropicPayload.output_config?.effort

  const openAIPayload = translateToOpenAI(anthropicPayload, { wants1M, effort })
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  // Pre-flight prompt token check.
  // The Copilot backend rejects requests where the prompt exceeds
  // max_prompt_tokens (verified empirically: e.g. 168467 > 168000 for
  // claude-opus-4.7-xhigh returns 400 "prompt token count of N exceeds the
  // limit of M"). Returning the error in Anthropic format up front lets the
  // client surface a clean message instead of an opaque upstream 400.
  //
  // Other model spec fields (max_output_tokens, max_non_streaming_output_tokens,
  // min/max_thinking_budget, adaptive_thinking) are NOT enforced by Copilot —
  // requests with absurd values silently succeed. So we don't pre-clamp them.
  const selectedModel = state.models?.data.find(
    (m) => m.id === openAIPayload.model,
  )
  if (selectedModel) {
    const tokenError = await checkPromptTokenLimit(openAIPayload, selectedModel)
    if (tokenError) {
      return c.json(tokenError, 400)
    }
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

/**
 * Estimate prompt token count and return an Anthropic-format error object
 * if the payload exceeds the model's max_prompt_tokens. Returns null if OK
 * or if the limit is unknown.
 */
async function checkPromptTokenLimit(
  payload: ChatCompletionsPayload,
  model: Model,
): Promise<{
  type: string
  error: { type: string; message: string }
} | null> {
  const maxPromptTokens = model.capabilities.limits?.max_prompt_tokens
  if (!maxPromptTokens) return null

  try {
    const tokenCount = await getTokenCount(payload, model)
    const estimated = tokenCount.input + tokenCount.output
    if (estimated > maxPromptTokens) {
      consola.warn(
        `Prompt token pre-check failed: estimated ${estimated} exceeds limit ${maxPromptTokens} for model ${model.id}`,
      )
      return {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `prompt token count of ${estimated} exceeds the limit of ${maxPromptTokens} for model ${model.id}. Consider compacting or reducing context.`,
        },
      }
    }
  } catch (err) {
    // Non-fatal: if token counting fails, let the request through.
    consola.warn("Pre-flight token count failed, skipping check:", err)
  }

  return null
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
