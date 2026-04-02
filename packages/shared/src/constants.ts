export const ADAPTER_CATEGORIES = [
  "banking",
  "payment",
  "ledger",
  "notification",
  "identity",
] as const;

export const LIFECYCLE_STATES = [
  "draft",
  "active",
  "paused",
  "retired",
  "archived",
] as const;

export const SIMULATION_MODES = ["dry-run", "deterministic", "chaos"] as const;
