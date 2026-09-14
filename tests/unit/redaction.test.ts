import { describe, expect, it } from "vitest";
import { redactSensitiveValues } from "../../src/safety/redaction.js";

describe("redactSensitiveValues", () => {
  it("replaces every occurrence of a redact-flagged hint's value with a named placeholder", () => {
    const hints = [
      { name: "password", value: "secret_sauce", redact: true },
      { name: "username", value: "standard_user", redact: false },
    ];
    const result = redactSensitiveValues(
      'typed "secret_sauce" into the password field, then "standard_user" into username',
      hints,
    );
    expect(result).toBe('typed "[REDACTED:password]" into the password field, then "standard_user" into username');
  });

  it("leaves text unchanged when no hint matches or none are marked sensitive", () => {
    const hints = [{ name: "username", value: "standard_user", redact: false }];
    const text = "clicked the Login button";
    expect(redactSensitiveValues(text, hints)).toBe(text);
    expect(redactSensitiveValues(text, [])).toBe(text);
  });

  it("redacts every occurrence, not just the first", () => {
    const hints = [{ name: "pin", value: "1234", redact: true }];
    expect(redactSensitiveValues("pin=1234 confirm=1234", hints)).toBe("pin=[REDACTED:pin] confirm=[REDACTED:pin]");
  });
});
