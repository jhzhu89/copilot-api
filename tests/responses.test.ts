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

test("retries connection-mismatched Responses without stale reasoning", async () => {
  const upstreamBodies: Array<Record<string, unknown>> = []
  let tokenRefreshes = 0
  let reasoningAttempts = 0

  const refreshedConnectionFetch = mock(
    (input: string | URL | Request, init?: RequestInit) => {
      let url: string
      if (typeof input === "string") url = input
      else if (input instanceof URL) url = input.href
      else url = input.url
      if (url.includes("/copilot_internal/v2/token")) {
        tokenRefreshes += 1
        return Promise.resolve(Response.json({ token: "refreshed-test-token" }))
      }

      if (typeof init?.body !== "string") {
        throw new TypeError("Expected a JSON body")
      }
      const body = JSON.parse(init.body) as Record<string, unknown>
      upstreamBodies.push(body)
      const inputItems = body.input as Array<Record<string, unknown>>
      const hasReasoning = inputItems.some((item) => item.type === "reasoning")

      if (!hasReasoning) {
        return Promise.resolve(
          Response.json({ id: "recovered-response", output: [] }),
        )
      }

      reasoningAttempts += 1
      if (reasoningAttempts === 1) {
        return Promise.resolve(
          Response.json(
            { error: { message: "expired authentication token" } },
            { status: 401 },
          ),
        )
      }

      return Promise.resolve(
        Response.json(
          {
            error: {
              message: "input item does not belong to this connection",
              code: "",
            },
          },
          { status: 401 },
        ),
      )
    },
  )
  // @ts-expect-error - Mock fetch doesn't implement Bun's preconnect property
  globalThis.fetch = refreshedConnectionFetch

  const response = await responsesRoutes.request("/", {
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: [
        {
          type: "reasoning",
          summary: [],
          encrypted_content: "stale-encrypted-reasoning",
        },
        { type: "message", role: "user", content: "continue" },
      ],
      stream: false,
      store: false,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  expect(response.status).toBe(200)
  expect(tokenRefreshes).toBe(1)
  expect(upstreamBodies).toHaveLength(3)
  expect(upstreamBodies[2]?.input).toEqual([
    { type: "message", role: "user", content: "continue" },
  ])
})
