import type { ModelGroup, SensitivityCategory } from "@nodaq/shared";

/**
 * Thrown when something attempts to route a payload to a model tier that its
 * sensitivity category forbids. This is the LAST line of defense: even a
 * misconfigured policy must never emit `confidentiel` traffic to `frontier`.
 * Carries names only — never content.
 */
export class SovereigntyViolationError extends Error {
  constructor(
    readonly category: SensitivityCategory,
    readonly group: ModelGroup,
    readonly requestId: string,
  ) {
    super(
      `sovereignty violation: category "${category}" must not route to tier "${group}" (request ${requestId})`,
    );
    this.name = "SovereigntyViolationError";
  }
}
