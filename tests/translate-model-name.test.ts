import { describe, test, expect, beforeEach } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import { translateModelName } from "../src/routes/messages/non-stream-translation"

const ONE_M = { wants1M: true }

// Only `id` is read by translateModelName; cast to keep fixtures small.
const mkModel = (id: string): Model => ({ id, object: "model" }) as Model

describe("translateModelName", () => {
  beforeEach(() => {
    state.models = undefined
  })

  describe("pass-through", () => {
    test("non-Claude models pass through unchanged", () => {
      expect(translateModelName("gpt-4o")).toBe("gpt-4o")
      expect(translateModelName("gpt-5.1")).toBe("gpt-5.1")
    })

    test("already-dotted Claude names pass through when no model list", () => {
      expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
      expect(translateModelName("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
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

    test("handles date-only suffix (no minor version)", () => {
      expect(translateModelName("claude-sonnet-4-20260101")).toBe(
        "claude-sonnet-4",
      )
    })
  })

  describe("default behavior (wants1M=false): no upgrade", () => {
    test("does NOT upgrade when wants1M is not set, even if -1m variant exists", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.6"), mkModel("claude-opus-4.6-1m")],
      }

      expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
      expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
    })

    test("strips -1m suffix from input when client did NOT request 1M", () => {
      // Defensive: if a stale config or upstream layer hands us a -1m name
      // while the client has not asked for 1M, do not silently keep it.
      expect(translateModelName("claude-opus-4.6-1m")).toBe("claude-opus-4.6")
      expect(translateModelName("claude-opus-4.7-1m-internal")).toBe(
        "claude-opus-4.7",
      )
    })
  })

  describe("explicit 1M via wants1M option", () => {
    test("upgrades to -1m variant when wants1M=true and -1m exists", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.6"), mkModel("claude-opus-4.6-1m")],
      }

      expect(translateModelName("claude-opus-4-6", ONE_M)).toBe(
        "claude-opus-4.6-1m",
      )
      expect(translateModelName("claude-opus-4.6", ONE_M)).toBe(
        "claude-opus-4.6-1m",
      )
    })

    test("falls back to -1m-internal when -1m not present (claude-opus-4.7)", () => {
      state.models = {
        object: "list",
        data: [
          mkModel("claude-opus-4.7"),
          mkModel("claude-opus-4.7-1m-internal"),
        ],
      }

      expect(translateModelName("claude-opus-4-7", ONE_M)).toBe(
        "claude-opus-4.7-1m-internal",
      )
      expect(translateModelName("claude-opus-4.7", ONE_M)).toBe(
        "claude-opus-4.7-1m-internal",
      )
    })

    test("prefers -1m over -1m-internal when both available", () => {
      state.models = {
        object: "list",
        data: [
          mkModel("claude-opus-4.7"),
          mkModel("claude-opus-4.7-1m"),
          mkModel("claude-opus-4.7-1m-internal"),
        ],
      }

      expect(translateModelName("claude-opus-4-7", ONE_M)).toBe(
        "claude-opus-4.7-1m",
      )
    })

    test("does not double-upgrade already -1m / -1m-internal names", () => {
      state.models = {
        object: "list",
        data: [
          mkModel("claude-opus-4.6-1m"),
          mkModel("claude-opus-4.7-1m-internal"),
        ],
      }

      expect(translateModelName("claude-opus-4.6-1m", ONE_M)).toBe(
        "claude-opus-4.6-1m",
      )
      expect(translateModelName("claude-opus-4-6-1m", ONE_M)).toBe(
        "claude-opus-4.6-1m",
      )
      expect(translateModelName("claude-opus-4.7-1m-internal", ONE_M)).toBe(
        "claude-opus-4.7-1m-internal",
      )
    })

    test("does not upgrade when no -1m variant exists in model list", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.6")],
      }

      expect(translateModelName("claude-opus-4-6", ONE_M)).toBe(
        "claude-opus-4.6",
      )
    })

    test("does not upgrade when no model list loaded", () => {
      expect(translateModelName("claude-opus-4-6", ONE_M)).toBe(
        "claude-opus-4.6",
      )
    })
  })

  describe("[1m] suffix handling (legacy: implies wants1M=true)", () => {
    test("strips [1m] suffix and treats as wants1M=true", () => {
      // No model list: dash-to-dot only, no upgrade target available
      expect(translateModelName("claude-opus-4-6[1m]")).toBe("claude-opus-4.6")
    })

    test("with [1m] suffix and -1m variant available, upgrades", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.6"), mkModel("claude-opus-4.6-1m")],
      }

      expect(translateModelName("claude-opus-4-6[1m]")).toBe(
        "claude-opus-4.6-1m",
      )
    })

    test("[1m] on already-dotted name", () => {
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.6-1m")],
      }

      expect(translateModelName("claude-opus-4.6[1m]")).toBe(
        "claude-opus-4.6-1m",
      )
    })

    test("[1m] takes precedence even when wants1M=false", () => {
      // If both signals are present, [1m] still implies 1M intent.
      state.models = {
        object: "list",
        data: [mkModel("claude-opus-4.6"), mkModel("claude-opus-4.6-1m")],
      }

      expect(
        translateModelName("claude-opus-4-6[1m]", { wants1M: false }),
      ).toBe("claude-opus-4.6-1m")
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
