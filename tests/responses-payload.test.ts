import { expect, test } from "bun:test"

import { normalizeResponsesPayload } from "../src/routes/responses/handler"

test("fills empty additional-tools namespace descriptions", () => {
  const payload = {
    model: "gpt-test",
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            description: "",
            tools: [],
          },
          {
            type: "namespace",
            name: "web",
            description: "Existing description",
            tools: [],
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: "hello",
      },
    ],
  }

  const result = normalizeResponsesPayload(payload)
  const additionalTools = result.input.at(0)

  expect(additionalTools).toBeDefined()
  if (
    !additionalTools
    || !("tools" in additionalTools)
    || !Array.isArray(additionalTools.tools)
  ) {
    throw new Error("Expected an additional_tools input item")
  }

  const [functionsNamespace, webNamespace] = additionalTools.tools

  expect(functionsNamespace.description).toBe(
    "Tools in the functions namespace.",
  )
  expect(webNamespace.description).toBe("Existing description")
  expect(result.input[1]).toEqual(payload.input[1])
})
