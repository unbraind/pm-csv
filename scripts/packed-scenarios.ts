/** One package-manager and host-version combination exercised in isolation. */
export interface AcceptanceScenario {
  readonly name: string;
  readonly manager: "npm" | "bun";
  readonly hostVersion: string;
}

/** Exercise both managers and every distinct supported npm host version once. */
export function packedScenarios(developmentVersion: string, minimumVersion: string): AcceptanceScenario[] {
  const scenarios: AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", hostVersion: developmentVersion },
    { name: "bun-current", manager: "bun", hostVersion: developmentVersion },
  ];
  if (developmentVersion !== minimumVersion) scenarios.push({ name: "npm-minimum", manager: "npm", hostVersion: minimumVersion });
  return scenarios;
}
