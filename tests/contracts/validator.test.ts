import { describe, expect, it } from "vitest";
import { validateTaskContract, type TaskContract } from "../../src/index.js";

const validContract: TaskContract = {
  id: "readme_patch_one_file",
  taskType: "patch_one_file",
  promptQuality: "P0",
  goal: "Update README usage text",
  allowedFiles: ["README.md"],
  forbiddenFiles: ["package.json"],
  verificationRequired: ["pnpm test"]
};

describe("TaskContract validator", () => {
  it("accepts a valid task contract", () => {
    const result = validateTaskContract(validContract);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.allowedFiles).toEqual(["README.md"]);
    }
  });

  it("rejects missing required fields", () => {
    const result = validateTaskContract({
      goal: "Update README usage text",
      allowedFiles: ["README.md"]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.path)).toEqual(expect.arrayContaining(["$.taskType"]));
    }
  });

  it("rejects unsafe allowed and forbidden paths", () => {
    const result = validateTaskContract({
      ...validContract,
      allowedFiles: ["/tmp/README.md"],
      forbiddenFiles: ["../package.json"]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["unsafe_path"]));
    }
  });

  it("rejects invalid prompt quality", () => {
    const result = validateTaskContract({
      ...validContract,
      promptQuality: "PX"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([expect.objectContaining({ path: "$.promptQuality", code: "invalid_prompt_quality" })]);
    }
  });

  it("does not mutate input", () => {
    const input = { ...validContract, allowedFiles: ["README.md"] };
    const before = JSON.stringify(input);

    validateTaskContract(input);

    expect(JSON.stringify(input)).toBe(before);
  });
});
