import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

export const setupCopilotToken = async () => {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  const refreshInterval = (refresh_in - 60) * 1000
  setInterval(() => {
    void refreshCopilotToken().catch(() => {
      // Errors already logged inside refreshCopilotToken; swallow so the
      // interval keeps firing and the next on-demand 401 retry can recover.
    })
  }, refreshInterval)
}

let inFlightRefresh: Promise<boolean> | undefined

/**
 * Refresh the short-lived Copilot token. Safe to call concurrently — overlapping
 * callers share the same in-flight promise. Returns true on success.
 *
 * Used both by the periodic timer in `setupCopilotToken` and by `copilotFetch`
 * when an upstream request returns 401 (e.g. after the host machine wakes from
 * sleep and the cached token has expired).
 */
export const refreshCopilotToken = async (): Promise<boolean> => {
  if (inFlightRefresh) return inFlightRefresh

  inFlightRefresh = (async () => {
    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        consola.debug(
          `Refreshing Copilot token (attempt ${attempt}/${maxRetries})`,
        )
        const { token } = await getCopilotToken()
        state.copilotToken = token
        consola.debug("Copilot token refreshed")
        if (state.showToken) {
          consola.info("Refreshed Copilot token:", token)
        }
        return true
      } catch (error) {
        consola.error(
          `Failed to refresh Copilot token (attempt ${attempt}/${maxRetries}):`,
          error,
        )
        if (attempt < maxRetries) {
          const delay = attempt * 5000
          consola.warn(`Retrying in ${delay / 1000}s...`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }
    consola.error("All Copilot token refresh attempts exhausted.")
    return false
  })().finally(() => {
    inFlightRefresh = undefined
  })

  return inFlightRefresh
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
