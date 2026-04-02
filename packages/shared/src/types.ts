export type Tenant = {
  id: string;
  name: string;
  region: string;
  createdAt: string;
};

export type Adapter = {
  id: string;
  tenantId: string;
  category: AdapterCategory;
  state: LifecycleState;
  version: string;
};

export type Config = {
  tenantId: string;
  key: string;
  value: string;
  isSecret: boolean;
};

export type Requirement = {
  id: string;
  tenantId: string;
  title: string;
  status: LifecycleState;
  priority: number;
};

export type DAGNode = {
  id: string;
  name: string;
  kind: "task" | "decision" | "trigger";
  dependsOn: string[];
};

export type AdapterCategory =
  | "banking"
  | "payment"
  | "ledger"
  | "notification"
  | "identity";

export type LifecycleState =
  | "draft"
  | "active"
  | "paused"
  | "retired"
  | "archived";

export type SimulationMode = "dry-run" | "deterministic" | "chaos";
