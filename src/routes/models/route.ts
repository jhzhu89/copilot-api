import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => {
      const { limits, supports, family, tokenizer } = model.capabilities
      return {
        id: model.id,
        object: "model",
        type: "model",
        created: 0, // No date available from source
        created_at: new Date(0).toISOString(), // No date available from source
        owned_by: model.vendor,
        display_name: model.name,
        family,
        tokenizer,
        preview: model.preview,
        supported_endpoints: model.supported_endpoints,
        ...(limits && {
          limits: {
            max_context_window_tokens: limits.max_context_window_tokens,
            max_output_tokens: limits.max_output_tokens,
            max_non_streaming_output_tokens:
              limits.max_non_streaming_output_tokens,
            max_prompt_tokens: limits.max_prompt_tokens,
            vision: limits.vision,
          },
        }),
        ...(supports && {
          supports: {
            tool_calls: supports.tool_calls,
            parallel_tool_calls: supports.parallel_tool_calls,
            streaming: supports.streaming,
            structured_outputs: supports.structured_outputs,
            vision: supports.vision,
            adaptive_thinking: supports.adaptive_thinking,
            max_thinking_budget: supports.max_thinking_budget,
            min_thinking_budget: supports.min_thinking_budget,
            reasoning_effort: supports.reasoning_effort,
          },
        }),
      }
    })

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
