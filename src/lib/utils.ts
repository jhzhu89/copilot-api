import consola from "consola"

import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
  state.modelsFetchedAt = Date.now()
}

/**
 * How long a cached model list stays fresh before `ensureModels` refreshes it.
 * Upstream model changes (new ids, changed reasoning_effort support) are rare,
 * so an hour balances staleness against load on the Copilot models endpoint.
 */
const MODELS_TTL_MS = 60 * 60 * 1000

/**
 * Tracks an in-flight refresh so concurrent requests that arrive after the TTL
 * expires share a single upstream fetch instead of stampeding it.
 */
let modelsRefresh: Promise<void> | null = null

/**
 * Ensure `state.models` is present and fresh, refreshing from upstream when it
 * is missing or older than MODELS_TTL_MS. Safe to call on every request:
 *
 *  - Fresh cache → returns immediately (no await of a network call).
 *  - Expired/missing → fetches once; concurrent callers await the same promise.
 *  - Refresh failure → keeps the existing (stale) cache and logs a warning,
 *    so a transient upstream error never blanks the model list out from under
 *    the hot paths that depend on it (effort mapping, token limits, routing).
 */
export async function ensureModels(): Promise<void> {
  const fresh =
    state.models !== undefined
    && state.modelsFetchedAt !== undefined
    && Date.now() - state.modelsFetchedAt < MODELS_TTL_MS
  if (fresh) return

  // Coalesce concurrent refreshes onto a single upstream request.
  modelsRefresh ??= (async () => {
    try {
      await cacheModels()
    } catch (error) {
      // Stale-on-error: never clear an existing cache because of a transient
      // upstream failure. If we have nothing cached at all, callers still see
      // state.models === undefined and degrade exactly as they did before.
      consola.warn("Model cache refresh failed; keeping stale cache:", error)
    } finally {
      modelsRefresh = null
    }
  })()

  return modelsRefresh
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
