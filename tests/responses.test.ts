import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { responsesRoutes } from "../src/routes/responses/route"

const originalFetch = globalThis.fetch

let forwardedBody: Record<string, unknown> | undefined

const fetchMock = mock((_input: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON body")
  forwardedBody = JSON.parse(init.body) as Record<string, unknown>
  return Promise.resolve(
    new Response(JSON.stringify({ id: "response-id", output: [] }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  )
})

beforeEach(() => {
  forwardedBody = undefined
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.manualApprove = false
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  // @ts-expect-error - Mock fetch doesn't implement Bun's preconnect property
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("removes connection-bound item metadata from stateless Responses input", async () => {
  const response = await responsesRoutes.request("/", {
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: [
        {
          id: "reasoning-item-id",
          type: "reasoning",
          status: "completed",
          summary: [],
          encrypted_content: "encrypted-reasoning",
        },
        {
          id: "tool-output-item-id",
          type: "function_call_output",
          status: "completed",
          call_id: "call-id-to-preserve",
          output: "tool result",
        },
      ],
      stream: false,
      store: false,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(forwardedBody?.input).toEqual([
    {
      type: "reasoning",
      summary: [],
      encrypted_content: "encrypted-reasoning",
    },
    {
      type: "function_call_output",
      call_id: "call-id-to-preserve",
      output: "tool result",
    },
  ])
})

test("drops connection-bound item references from stateless Responses input", async () => {
  const response = await responsesRoutes.request("/", {
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: [
        { type: "item_reference", id: "stale-item-id" },
        { type: "message", role: "user", content: "continue" },
      ],
      stream: false,
      store: false,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(forwardedBody?.input).toEqual([
    { type: "message", role: "user", content: "continue" },
  ])
})

test("preserves item metadata when Responses storage is enabled", async () => {
  const input = [
    {
      id: "stored-reasoning-item-id",
      type: "reasoning",
      status: "completed",
      summary: [],
    },
    { type: "item_reference", id: "stored-item-reference" },
  ]

  const response = await responsesRoutes.request("/", {
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input,
      stream: false,
      store: true,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(forwardedBody?.input).toEqual(input)
})
