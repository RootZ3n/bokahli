import { describe, expect, it } from "vitest";

const config = {
  auditEverySteps: 5,
  allowMultiFileWorkerTasks: false
};

describe("config", () => {
  it("audits every 5 steps", () => {
    expect(config.auditEverySteps).toBe(5);
  });

  it("does not allow multi-file worker tasks", () => {
    expect(config.allowMultiFileWorkerTasks).toBe(false);
  });
});
