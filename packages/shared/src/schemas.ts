import { z } from "zod";
import {
  ADAPTER_CATEGORIES,
  LIFECYCLE_STATES,
  SIMULATION_MODES,
} from "./constants.js";

export const TenantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  region: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const AdapterSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  category: z.enum(ADAPTER_CATEGORIES),
  state: z.enum(LIFECYCLE_STATES),
  version: z.string().min(1),
});

export const ConfigSchema = z.object({
  tenantId: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
  isSecret: z.boolean(),
});

export const RequirementSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(LIFECYCLE_STATES),
  priority: z.number().int().min(1).max(5),
});

export const DAGNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["task", "decision", "trigger"]),
  dependsOn: z.array(z.string().min(1)),
});

export const HealthRequestSchema = z.object({});

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
});

export const WebHealthResponseSchema = HealthResponseSchema;
export const ApiHealthResponseSchema = HealthResponseSchema;
export const AiHealthResponseSchema = HealthResponseSchema;
export const SimulatorHealthResponseSchema = HealthResponseSchema;

export const SimulationModeSchema = z.enum(SIMULATION_MODES);
