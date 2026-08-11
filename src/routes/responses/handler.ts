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

type AdditionalToolsInput = Record<string, unknown> & {
  tools: Array<unknown>
}

type EmptyNamespaceTool = Record<string, unknown> & {
  name: string
  description: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAdditionalToolsInput(value: unknown): value is AdditionalToolsInput {
  return (
    isRecord(value)
    && value.type === "additional_tools"
    && Array.isArray(value.tools)
  )
}

function isEmptyNamespaceTool(value: unknown): value is EmptyNamespaceTool {
  return (
    isRecord(value)
    && value.type === "namespace"
    && typeof value.name === "string"
    && typeof value.description === "string"
    && value.description.trim().length === 0
  )
}

export function normalizeResponsesPayload<T extends ResponsesPayload>(
  payload: T,
): T {
  if (!Array.isArray(payload.input)) return payload

  for (const inputItem of payload.input as Array<unknown>) {
    if (!isAdditionalToolsInput(inputItem)) continue

    for (const tool of inputItem.tools) {
      if (isEmptyNamespaceTool(tool)) {
        tool.description = `Tools in the ${tool.name} namespace.`
      }
    }
  }

  return payload
}

export const sanitizeResponsesPayload = (
  payload: ResponsesPayload,
): ResponsesPayload => {
  if (payload.store === true || !Array.isArray(payload.input)) return payload
  const inputItems = payload.input as Array<unknown>

  return {
    ...payload,
    input: inputItems.flatMap((item) => {
      if (!isRecord(item)) return item
      if (item.type === "item_reference") return []

      const sanitizedItem = { ...item }
      delete sanitizedItem.id
      delete sanitizedItem.status
      return sanitizedItem
    }),
  }
}

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = sanitizeResponsesPayload(
    normalizeResponsesPayload(await c.req.json<ResponsesPayload>()),
  )
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
