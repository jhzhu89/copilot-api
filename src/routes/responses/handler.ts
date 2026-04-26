import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { copilotFetch } from "~/lib/copilot-fetch"
import { HTTPError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"

interface ResponsesPayload {
  model: string
  input: unknown
  stream?: boolean
  [key: string]: unknown
}

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  consola.debug(
    "Responses request payload:",
    JSON.stringify(payload).slice(-400),
  )

  if (state.manualApprove) await awaitApproval()

  if (!state.copilotToken) throw new Error("Copilot token not found")

  const body = JSON.stringify(payload)
  const isStreaming = payload.stream === true

  const response = await copilotFetch(
    `${copilotBaseUrl(state)}/responses`,
    () => ({
      method: "POST",
      headers: {
        ...copilotHeaders(state),
        "X-Initiator": "agent",
      },
      body,
    }),
  )

  if (!response.ok) {
    consola.error(
      "Failed to create response",
      response.status,
      response.statusText,
    )
    throw new HTTPError("Failed to create response", response)
  }

  // Non-streaming: return JSON directly
  if (!isStreaming) {
    const data = await response.json()
    consola.debug(
      "Responses non-stream result:",
      JSON.stringify(data).slice(-400),
    )
    return c.json(data)
  }

  // Streaming: forward SSE events
  consola.debug("Responses streaming response")
  return streamSSE(c, async (sseStream) => {
    const eventStream = events(response)
    for await (const event of eventStream) {
      consola.debug("Responses SSE chunk:", JSON.stringify(event).slice(-200))
      await sseStream.writeSSE({
        data: event.data ?? "",
        event: event.event,
        id: event.id?.toString(),
      })
    }
  })
}
