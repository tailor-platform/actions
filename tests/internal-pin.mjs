import assert from "node:assert/strict";

// Renovate bumps third-party pins inside _internal; the pinned commit may lag them without changing behavior.
export const withoutThirdPartyShas = (action) => ({
  ...action,
  runs: {
    ...action.runs,
    steps: action.runs.steps.map((step) =>
      step.uses && !step.uses.startsWith("tailor-platform/actions/") ? { ...step, uses: step.uses.replace(/@[0-9a-f]{40}$/, "@<sha>") } : step,
    ),
  },
});

export const thirdPartyUses = (action) => action.runs.steps.map((step) => step.uses).filter((uses) => uses && !uses.startsWith("tailor-platform/actions/"));

export function classifyPin({ sha, pinned, local, isAncestor }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return { status: "invalid", reason: "the pin is not a full commit SHA" };
  if (!pinned) return { status: "invalid", reason: "the pinned commit has no definition" };
  if (!isAncestor) return { status: "invalid", reason: "the pinned commit is not in this branch's history" };
  try {
    assert.deepEqual(withoutThirdPartyShas(pinned), withoutThirdPartyShas(local));
  } catch {
    return { status: "behind", reason: "the working tree changed after the pinned commit" };
  }
  return { status: "match" };
}
