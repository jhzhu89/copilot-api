import { describe, test, expect, beforeEach } from "bun:test"

import { state } from "../src/lib/state"
import { translateModelName } from "../src/routes/messages/non-stream-translation"

describe("translateModelName", () => {
  beforeEach(() => {
    // Reset model list before each test
    state.models = undefined
  })

  describe("pass-through", () => {
    test("non-Claude models pass through unchanged", () => {
      expect(translateModelName("gpt-4o")).toBe("gpt-4o")
      expect(translateModelName("gpt-5.1")).toBe("gpt-5.1")
    })

    test("already-dotted Claude names pass through", () => {
      expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
      expect(translateModelName("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
      expect(translateModelName("claude-opus-4.6-1m")).toBe(
        "claude-opus-4.6-1m",
      )
    })
  })

  describe("dash-to-dot conversion", () => {
    test("converts major-minor dashes to dots", () => {
      expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
      expect(translateModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
      expect(translateModelName("claude-haiku-4-5")).toBe("claude-haiku-4.5")
    })

    test("strips date suffixes", () => {
      expect(translateModelName("claude-haiku-4-5-20251001")).toBe(
        "claude-haiku-4.5",
      )
      expect(translateModelName("claude-sonnet-4-6-20260101")).toBe(
        "claude-sonnet-4.6",
      )
    })

    test("preserves non-date suffixes", () => {
      expect(translateModelName("claude-opus-4-6-1m")).toBe(
        "claude-opus-4.6-1m",
      )
    })

    test("handles date-only suffix (no minor version)", () => {
      expect(translateModelName("claude-sonnet-4-20260101")).toBe(
        "claude-sonnet-4",
      )
    })
  })

  describe("[1m] suffix handling", () => {
    test("strips [1m] and converts model name", () => {
      expect(translateModelName("claude-opus-4-6[1m]")).toBe("claude-opus-4.6")
    })

    test("auto-upgrades to -1m when available in model list", () => {
      state.models = {
        data: [
          { id: "claude-opus-4.6", object: "model", type: "model", created: 0 },
          {
            id: "claude-opus-4.6-1m",
            object: "model",
            type: "model",
            created: 0,
          },
        ],
      }

      expect(translateModelName("claude-opus-4-6[1m]")).toBe(
        "claude-opus-4.6-1m",
      )
    })

    test("falls back to base model when -1m not in model list", () => {
      state.models = {
        data: [
          { id: "claude-opus-4.6", object: "model", type: "model", created: 0 },
        ],
      }

      expect(translateModelName("claude-opus-4-6[1m]")).toBe("claude-opus-4.6")
    })

    test("[1m] on already-dotted name", () => {
      state.models = {
        data: [
          {
            id: "claude-opus-4.6-1m",
            object: "model",
            type: "model",
            created: 0,
          },
        ],
      }

      expect(translateModelName("claude-opus-4.6[1m]")).toBe(
        "claude-opus-4.6-1m",
      )
    })
  })

  describe("subagent model names (stock behavior preserved)", () => {
    test("claude-sonnet-4-* maps to claude-sonnet-4", () => {
      expect(translateModelName("claude-sonnet-4-20250514")).toBe(
        "claude-sonnet-4",
      )
    })

    test("claude-opus-4-* maps to claude-opus-4", () => {
      expect(translateModelName("claude-opus-4-20250514")).toBe("claude-opus-4")
    })
  })
})
