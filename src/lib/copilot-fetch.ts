import consola from "consola"

import { refreshCopilotToken } from "./token"

/**
 * Build the per-request `init` from the latest token. Recomputed on retry so
 * the refreshed bearer token is picked up.
 */
type InitBuilder = () => RequestInit

/**
 * `fetch` wrapper that, on a single 401 response, refreshes the Copilot
 * token and retries the request once. This rescues requests issued right
 * after the host machine wakes from sleep, when the cached short-lived
 * token has expired but the periodic refresh interval has not yet caught up.
 */
export const copilotFetch = async (
  url: string,
  buildInit: InitBuilder,
): Promise<Response> => {
  const response = await fetch(url, buildInit())
  if (response.status !== 401) return response

  consola.warn(
    "Copilot upstream returned 401; refreshing token and retrying once.",
  )
  const refreshed = await refreshCopilotToken()
  if (!refreshed) return response

  return fetch(url, buildInit())
}
