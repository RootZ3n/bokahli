export function detectDrift(expected: string, observed: string): boolean {
  return expected !== observed;
}

export const driftPurpose = "detectDrift performs drift detection for repository expectations.";
