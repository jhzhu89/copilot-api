import { test, expect, mock, beforeEach, afterEach } from "bun:test"

import { state } from "../src/lib/state"
import { cacheModels, ensureModels } from "../src/lib/utils"

// ensureModels lazily refreshes state.models from upstream once the cache
// exceeds its TTL. These tests drive that logic by mocking the global fetch
// (which getModels calls under the hood) and by manipulating
// state.modelsFetchedAt to simulate a fresh vs. expired cache.

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const originalFetch = globalThis.fetch

const makeModelsResponse = (ids: Array<string>) => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model", capabilities: {} })),
})

let fetchCalls = 0
let nextIds: Array<string>
let shouldFail: boolean

const fetchMock = mock(() => {
  fetchCalls += 1
  if (shouldFail) {
    return { ok: false, status: 500, json: () => ({}) }
  }
  return { ok: true, json: () => makeModelsResponse(nextIds) }
})

beforeEach(() => {
  fetchCalls = 0
  nextIds = ["model-a"]
  shouldFail = false
  state.models = undefined
  state.modelsFetchedAt = undefined
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("fetches once when the cache is empty", async () => {
  await ensureModels()

  expect(fetchCalls).toBe(1)
  expect(state.models?.data.map((m) => m.id)).toEqual(["model-a"])
  expect(state.modelsFetchedAt).toBeDefined()
})

test("does not refetch while the cache is fresh", async () => {
  await ensureModels() // primes the cache (fetch #1)
  expect(fetchCalls).toBe(1)

  await ensureModels() // still fresh → no network
  await ensureModels()

  expect(fetchCalls).toBe(1)
})

test("refetches once the cache is older than the TTL", async () => {
  await ensureModels()
  expect(fetchCalls).toBe(1)

  // Simulate the cache aging past the 1h TTL.
  state.modelsFetchedAt = Date.now() - (60 * 60 * 1000 + 1)
  nextIds = ["model-b"]

  await ensureModels()

  expect(fetchCalls).toBe(2)
  expect(state.models?.data.map((m) => m.id)).toEqual(["model-b"])
})

test("stale-on-error: keeps the previous cache when refresh fails", async () => {
  await ensureModels() // good fetch → cache = [model-a]
  expect(state.models?.data.map((m) => m.id)).toEqual(["model-a"])

  // Expire the cache, then make the next upstream call fail.
  state.modelsFetchedAt = Date.now() - (60 * 60 * 1000 + 1)
  shouldFail = true

  await ensureModels() // should swallow the error and keep stale data

  expect(fetchCalls).toBe(2)
  expect(state.models?.data.map((m) => m.id)).toEqual(["model-a"])
})

test("coalesces concurrent refreshes into a single fetch", async () => {
  // All three callers arrive with an empty cache simultaneously.
  await Promise.all([ensureModels(), ensureModels(), ensureModels()])

  expect(fetchCalls).toBe(1)
  expect(state.models?.data.map((m) => m.id)).toEqual(["model-a"])
})

test("cacheModels stamps modelsFetchedAt", async () => {
  expect(state.modelsFetchedAt).toBeUndefined()

  await cacheModels()

  expect(state.modelsFetchedAt).toBeDefined()
  expect(state.models?.data.map((m) => m.id)).toEqual(["model-a"])
})
