import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  /**
   * Epoch ms when `models` was last fetched from upstream. Used by
   * `ensureModels` to lazily refresh the cache once it exceeds the TTL, so the
   * proxy picks up newly-shipped models / changed capabilities without a
   * restart.
   */
  modelsFetchedAt?: number
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
