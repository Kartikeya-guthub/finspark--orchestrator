import { ChangeEvent, Component, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  approveConfig,
  bootstrapTenant,
  getApiBaseUrl,
  getAuditTrail,
  getConfigDiff,
  getDocument,
  getLatestConfig,
  getRequirements,
  getSimulatorBaseUrl,
  runSimulation,
  uploadDocument,
  type AuditEventRecord,
  type ConfigVersionRecord,
  type DocumentRecord,
  type RequirementRecord,
  type SimulationResult,
} from "./api";
type HumanDiffItemTone = "added" | "modified" | "removed";

type HumanDiffItem = {
  id: string;
  tone: HumanDiffItemTone;
  text: string;
};

type SafeSimulationStep = {
  node_id: string;
  service_type: string;
  status: "success" | "failed" | "skipped";
  latency_ms: number;
  output: unknown;
  input: unknown;
};

type DashboardErrorBoundaryProps = {
  children: ReactNode;
};

type DashboardErrorBoundaryState = {
  hasError: boolean;
  errorMessage: string;
};

type ApprovalState = {
  engineerComment: string;
  architectComment: string;
};

type LoadState = "idle" | "loading" | "ready" | "error";

const defaultApprovalState: ApprovalState = {
  engineerComment: "Mappings look good",
  architectComment: "Ready for prod",
};

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-cyan-300 border-t-transparent" />;
}

function StatusPill({ label, tone = "slate" }: { label: string; tone?: "slate" | "cyan" | "green" | "amber" | "rose" }) {
  const palette: Record<string, string> = {
    slate: "bg-slate-800 text-slate-200 ring-slate-600/50",
    cyan: "bg-cyan-400/10 text-cyan-200 ring-cyan-400/30",
    green: "bg-emerald-400/10 text-emerald-200 ring-emerald-400/30",
    amber: "bg-amber-400/10 text-amber-100 ring-amber-400/30",
    rose: "bg-rose-400/10 text-rose-100 ring-rose-400/30",
  };

  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${palette[tone]}`}>{label}</span>;
}

function Panel({
  title,
  subtitle,
  children,
  accent = "from-cyan-500/15 to-blue-500/5",
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  accent?: string;
}) {
  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-slate-950/80 p-4 shadow-glow backdrop-blur-xl">
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${accent}`} />
      <div className="relative flex items-start justify-between gap-3 pb-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-100">{title}</h2>
          <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
        </div>
      </div>
      <div className="relative space-y-3">{children}</div>
    </section>
  );
}

class DashboardErrorBoundary extends Component<DashboardErrorBoundaryProps, DashboardErrorBoundaryState> {
  constructor(props: DashboardErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: unknown): DashboardErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown): void {
    console.error("Dashboard render error", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-3xl border border-rose-300/30 bg-rose-500/10 p-4 text-sm text-rose-100">
          <div className="font-semibold">Dashboard rendering error detected</div>
          <div className="mt-1 text-rose-200/90">
            {this.state.errorMessage || "An unexpected UI error occurred while rendering simulation results."}
          </div>
          <div className="mt-2 text-rose-200/80">Refresh the page and rerun simulation. If this repeats, capture this message and share it.</div>
        </div>
      );
    }

    return this.props.children;
  }
}

function normalizeForGrounding(value: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toneIcon(tone: HumanDiffItemTone): string {
  if (tone === "added") {
    return "🟢 Added";
  }
  if (tone === "modified") {
    return "🟡 Modified";
  }
  return "🔴 Removed";
}

function toHumanDiffItems(configDiff: Record<string, unknown> | null): HumanDiffItem[] {
  if (!configDiff) {
    return [];
  }

  const items: HumanDiffItem[] = [];
  const addedMappings = Array.isArray(configDiff.added_field_mappings) ? configDiff.added_field_mappings as Array<Record<string, unknown>> : [];
  const removedMappings = Array.isArray(configDiff.removed_field_mappings) ? configDiff.removed_field_mappings as Array<Record<string, unknown>> : [];
  const changedDagNodes = Array.isArray(configDiff.changed_dag_nodes) ? configDiff.changed_dag_nodes as Array<Record<string, unknown>> : [];

  for (const mapping of addedMappings.slice(0, 8)) {
    const source = String(mapping.source_field ?? "unknown_source");
    const target = String(mapping.target_field ?? "unknown_target");
    const adapter = String(mapping.adapter_name ?? "Unknown Adapter");
    items.push({
      id: `add-map-${source}-${target}-${adapter}`,
      tone: "added",
      text: `${source} mapping to ${target} via ${adapter}.`,
    });
  }

  for (const mapping of removedMappings.slice(0, 4)) {
    const source = String(mapping.source_field ?? "unknown_source");
    const target = String(mapping.target_field ?? "unknown_target");
    const adapter = String(mapping.adapter_name ?? "Unknown Adapter");
    items.push({
      id: `remove-map-${source}-${target}-${adapter}`,
      tone: "removed",
      text: `${source} → ${target} mapping removed from ${adapter}.`,
    });
  }

  for (const node of changedDagNodes.slice(0, 8)) {
    const changeType = String(node.change_type ?? "modified");
    if (changeType === "removed") {
      const removedNode = (node.node as Record<string, unknown> | undefined) ?? {};
      const serviceType = String(removedNode.service_type ?? "UNKNOWN");
      const action = String(removedNode.api_action ?? "unknown_action");
      items.push({
        id: `remove-node-${serviceType}-${action}`,
        tone: "removed",
        text: `${serviceType} step ${action} removed from orchestration DAG.`,
      });
      continue;
    }

    const before = (node.before as Record<string, unknown> | undefined) ?? {};
    const after = (node.after as Record<string, unknown> | undefined) ?? {};
    const beforeAction = String(before.api_action ?? "unknown_action");
    const afterAction = String(after.api_action ?? "unknown_action");
    const serviceType = String(after.service_type ?? before.service_type ?? "UNKNOWN");
    items.push({
      id: `mod-node-${serviceType}-${beforeAction}-${afterAction}`,
      tone: "modified",
      text: `${serviceType} action changed from ${beforeAction} to ${afterAction}.`,
    });
  }

  if (items.length === 0) {
    items.push({
      id: "fallback",
      tone: "modified",
      text: "No major mapping or DAG deltas detected yet.",
    });
  }

  return items;
}

function AuditSidebar({ events }: { events: AuditEventRecord[] }) {
  return (
    <aside className="rounded-3xl border border-white/10 bg-slate-950/80 p-4 shadow-glow backdrop-blur-xl lg:sticky lg:top-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-300">Audit Trail</h3>
          <p className="text-[11px] text-slate-500">Last 50 events</p>
        </div>
        <StatusPill label={`${events.length} events`} tone="cyan" />
      </div>
      <div className="max-h-[42rem] space-y-2 overflow-auto pr-1">
        {events.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-3 text-sm text-slate-500">Waiting for events...</div>
        ) : (
          events.map((event) => (
            <div key={event.id} className="rounded-2xl border border-white/10 bg-white/5 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-cyan-100">{event.action}</span>
                <span className="text-slate-500">{new Date(event.created_at).toLocaleTimeString()}</span>
              </div>
              <div className="mt-1 text-slate-300">{event.actor}</div>
              <div className="mt-1 text-slate-500">{event.entity_type}</div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

export default function Dashboard() {
  const [tenantId, setTenantId] = useState<string>("");
  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [requirements, setRequirements] = useState<RequirementRecord[]>([]);
  const [configVersion, setConfigVersion] = useState<ConfigVersionRecord | null>(null);
  const [configDiff, setConfigDiff] = useState<Record<string, unknown> | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEventRecord[]>([]);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [approval, setApproval] = useState<ApprovalState>(defaultApprovalState);
  const [uploadState, setUploadState] = useState<LoadState>("idle");
  const [pollingState, setPollingState] = useState<LoadState>("idle");
  const [intelligenceState, setIntelligenceState] = useState<LoadState>("idle");
  const [governanceState, setGovernanceState] = useState<LoadState>("idle");
  const [simulationState, setSimulationState] = useState<LoadState>("idle");
  const [message, setMessage] = useState<string>("Upload a BRD to start the golden path.");
  const [timelineLog, setTimelineLog] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const pollRef = useRef<number | null>(null);
  const pollStartedAtRef = useRef<number | null>(null);
  const lineRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [activeRequirementId, setActiveRequirementId] = useState<string | null>(null);
  const [highlightedLineIndex, setHighlightedLineIndex] = useState<number | null>(null);
  const [animatedStepIndex, setAnimatedStepIndex] = useState<number>(-1);

  const simulationTrace = useMemo<SafeSimulationStep[]>(() => {
    try {
      const trace = (simulation as { result?: { trace?: unknown } } | null)?.result?.trace;
      if (!Array.isArray(trace)) {
        return [];
      }

      return trace
        .filter((item) => Boolean(item) && typeof item === "object")
        .map((item, index) => {
          try {
            const row = item as Record<string, unknown>;
            const statusRaw = typeof row.status === "string" ? row.status : "success";
            const safeStatus: SafeSimulationStep["status"] = statusRaw === "failed" || statusRaw === "skipped" ? statusRaw : "success";
            return {
              node_id: typeof row.node_id === "string" ? row.node_id : `step_${index + 1}`,
              service_type: typeof row.service_type === "string" ? row.service_type : "UNKNOWN",
              status: safeStatus,
              latency_ms: typeof row.latency_ms === "number" ? row.latency_ms : 0,
              output: row.output,
              input: row.input,
            };
          } catch {
            return {
              node_id: `step_${index + 1}`,
              service_type: "UNKNOWN",
              status: "success",
              latency_ms: 0,
              output: null,
              input: null,
            };
          }
        });
    } catch (error) {
      console.error("Error parsing simulation trace", error);
      return [];
    }
  }, [simulation]);
  const redactedText = document?.redacted_content?.redacted_text?.trim() ?? "";
  const rawText = document?.raw_text?.trim() ?? "";
  const hasMaskedRedaction = Boolean(redactedText) && redactedText !== rawText;
  const configStatus = configVersion?.status ?? document?.parse_status ?? "waiting";
  const groundingText = (redactedText || rawText || "").trim();
  const groundingLines = useMemo(() => groundingText.split(/\r?\n/).filter((line) => line.trim().length > 0), [groundingText]);
  const humanDiffItems = useMemo(() => toHumanDiffItems(configDiff), [configDiff]);
  const parsedThreshold = useMemo(() => {
    for (const requirement of requirements) {
      const thresholdRaw = (requirement.conditions as Record<string, unknown> | null | undefined)?.threshold_amount_usd;
      if (typeof thresholdRaw === "number") {
        return thresholdRaw;
      }
      if (typeof thresholdRaw === "string") {
        const parsed = Number(thresholdRaw);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return 10000;
  }, [requirements]);
  const executiveSummary = useMemo(() => {
    const hasAadhaar = requirements.some((requirement) => requirement.api_action === "verify_aadhaar");
    const hasPassport = requirements.some((requirement) => requirement.api_action === "verify_passport");
    const hasSanctions = requirements.some((requirement) => requirement.api_action === "screen_sanctions");
    const hasKillSwitch = requirements.some((requirement) => requirement.api_action === "kill_switch");
    const hasEdd = requirements.some((requirement) => requirement.api_action === "verify_source_of_funds");
    const hasPayout = requirements.some((requirement) => requirement.api_action === "process_payout" || requirement.service_type === "PAYMENT");
    const readiness = configStatus === "approved" ? "Bank-Ready" : configStatus === "config_generated" ? "Awaiting Governance Approval" : "In Progress";

    if (requirements.length === 0) {
      return "Upload a BRD to generate integration intelligence and orchestration insights.";
    }

    return [
      `Project Guardian Processed:`,
      hasAadhaar && hasPassport ? "extracted a Global Identity Fork" : "extracted identity verification requirements",
      hasSanctions ? "with mandatory Sanctions Screening" : "with compliance checks",
      hasKillSwitch ? "and kill-switch controls" : "",
      hasEdd ? `plus a $${parsedThreshold.toLocaleString()} EDD Threshold` : "",
      hasPayout ? "and payout orchestration." : ".",
      `Status: ${readiness}.`,
    ].filter(Boolean).join(" ");
  }, [requirements, parsedThreshold, configStatus]);

  const flowNodes = useMemo(
    () => [
      { id: "aadhaar", label: "KYC Aadhaar", activeWhen: (step: SafeSimulationStep) => step.service_type === "KYC" },
      { id: "onfido", label: "Onfido", activeWhen: (step: SafeSimulationStep) => step.service_type === "KYC" },
      { id: "sanctions", label: "Sanctions Check", activeWhen: (step: SafeSimulationStep) => step.service_type === "FRAUD" || step.service_type === "BUREAU" },
      { id: "edd", label: "AA Verify", activeWhen: (step: SafeSimulationStep) => step.service_type === "OPEN_BANKING" || step.service_type === "ACCOUNT" },
      { id: "payout", label: "Wise Payout", activeWhen: (step: SafeSimulationStep) => step.service_type === "PAYMENT" },
    ],
    [],
  );
  const flowStates = useMemo(() => {
    try {
      const states: Record<string, "idle" | "running" | "success" | "failed"> = {
        aadhaar: "idle",
        onfido: "idle",
        sanctions: "idle",
        edd: "idle",
        payout: "idle",
      };

      if (simulationState === "loading") {
        if (flowNodes.length > 0) {
          const loopIndex = (Date.now() / 500 | 0) % flowNodes.length;
          const loopNode = flowNodes[loopIndex];
          if (loopNode?.id) {
            states[loopNode.id] = "running";
          }
        }
        return states;
      }

      const completedCount = animatedStepIndex + 1;
      if (completedCount <= 0 || simulationTrace.length === 0) {
        return states;
      }

      for (let index = 0; index < simulationTrace.length; index += 1) {
        if (index > animatedStepIndex) {
          break;
        }
        const step = simulationTrace[index];
        if (!step) continue;
        
        for (const node of flowNodes) {
          try {
            if (node?.activeWhen && node.activeWhen(step)) {
              states[node.id] = step.status === "failed" ? "failed" : "success";
            }
          } catch {
            // Ignore errors in node matching
            continue;
          }
        }
      }

      return states;
    } catch (error) {
      console.error("flowStates calculation error", error);
      return {
        aadhaar: "idle",
        onfido: "idle",
        sanctions: "idle",
        edd: "idle",
        payout: "idle",
      };
    }
  }, [simulationState, simulationTrace, animatedStepIndex, flowNodes]);
  const bureauStep = useMemo(() => simulationTrace.find((step) => step.service_type === "BUREAU"), [simulationTrace]);

  useEffect(() => {
    if (simulationState !== "loading" || simulationTrace.length === 0) {
      return;
    }
    const interval = setInterval(() => {
      setAnimatedStepIndex((current) => (current + 1 < simulationTrace.length ? current + 1 : current));
    }, 800);
    return () => clearInterval(interval);
  }, [simulationState, simulationTrace]);

  useEffect(() => {
    void bootstrapTenant().then((result) => {
      setTenantId(result.tenant_id);
      setTimelineLog((current: string[]) => [...current, `Tenant ready: ${result.name}`]);
    }).catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, []);

  useEffect(() => {
    if (!document?.id) {
      return;
    }

    if (pollRef.current) {
      window.clearInterval(pollRef.current);
    }

    setPollingState("loading");
    pollStartedAtRef.current = Date.now();
    const tick = async () => {
      try {
        const latestDocument = await getDocument(document.id);
        setDocument(latestDocument);
        if (latestDocument.parse_status === "config_generated") {
          setPollingState("ready");
          setTimelineLog((current: string[]) => [...current, `Config generated for ${latestDocument.filename}`]);
          if (tenantId) {
            const [reqs, cfg, audit] = await Promise.all([
              getRequirements(latestDocument.id),
              getLatestConfig(tenantId),
              getAuditTrail(tenantId),
            ]);
            setRequirements(reqs);
            setConfigVersion(cfg);
            setAuditEvents(audit);
            setConfigDiff(await getConfigDiff(cfg.id).catch(() => null));
            setIntelligenceState("ready");
            setGovernanceState("ready");
          }
          if (pollRef.current) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
          return;
        }

        if (latestDocument.parse_status === "failed") {
          setPollingState("error");
          setIntelligenceState("error");
          setMessage("Processing failed in AI service. Check AI/API terminal logs for exact error.");
          if (pollRef.current) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
          return;
        }

        if (pollStartedAtRef.current && Date.now() - pollStartedAtRef.current > 120000) {
          setPollingState("error");
          setMessage("Processing is taking too long. Click Refresh Intelligence or re-upload after checking service logs.");
          if (pollRef.current) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      } catch (error) {
        setPollingState("error");
        setMessage(error instanceof Error ? error.message : String(error));
      }
    };

    void tick();
    pollRef.current = window.setInterval(() => {
      void tick();
    }, 2500);

    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [document?.id, tenantId]);

  useEffect(() => {
    if (!tenantId) {
      return;
    }
    const timer = window.setInterval(() => {
      void getAuditTrail(tenantId)
        .then(setAuditEvents)
        .catch(() => undefined);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [tenantId]);

  useEffect(() => {
    if (!simulationTrace.length) {
      setAnimatedStepIndex(-1);
      return;
    }

    setAnimatedStepIndex(-1);
    let isActive = true;
    let stepCount = 0;
    const timer = window.setInterval(() => {
      if (!isActive) return;
      stepCount += 1;
      if (stepCount >= simulationTrace.length) {
        window.clearInterval(timer);
        isActive = false;
        return;
      }
      setAnimatedStepIndex(Math.min(stepCount, simulationTrace.length - 1));
    }, 280);

    return () => {
      isActive = false;
      window.clearInterval(timer);
    };
  }, [simulation?.simulation_run_id, simulationTrace.length]);

  function handleRequirementClick(requirement: RequirementRecord) {
    setActiveRequirementId(requirement.id);
    if (!groundingLines.length || !requirement.source_sentence) {
      setHighlightedLineIndex(null);
      return;
    }

    const target = normalizeForGrounding(requirement.source_sentence);
    const targetTokens = target.split(" ").filter((token) => token.length > 3);
    const lineIndex = groundingLines.findIndex((line) => {
      const normalized = normalizeForGrounding(line);
      if (!normalized) {
        return false;
      }
      if (normalized.includes(target)) {
        return true;
      }
      const overlapCount = targetTokens.filter((token) => normalized.includes(token)).length;
      return overlapCount >= Math.max(3, Math.floor(targetTokens.length * 0.45));
    });

    if (lineIndex >= 0) {
      setHighlightedLineIndex(lineIndex);
      window.setTimeout(() => {
        lineRefs.current[lineIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 20);
    } else {
      setHighlightedLineIndex(null);
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    if (!file || !tenantId) {
      return;
    }

    setUploadState("loading");
    setMessage("Uploading and starting the intent engine...");
    try {
      const result = await uploadDocument(file, tenantId);
      setDocument(result.document);
      setTimelineLog((current: string[]) => [...current, `Uploaded ${result.document.filename}`]);
      setUploadState("ready");
      setPollingState("loading");
      const currentDocument = await getDocument(result.document.id);
      setDocument(currentDocument);
    } catch (error) {
      setUploadState("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshIntel(docId: string) {
    setIntelligenceState("loading");
    try {
      const latestDocument = await getDocument(docId);
      setDocument(latestDocument);
      if (latestDocument.parse_status !== "config_generated") {
        setIntelligenceState("idle");
        setMessage(`Document status is ${latestDocument.parse_status}. Waiting for AI completion.`);
        return;
      }

      const [reqs, cfg, audit] = await Promise.all([
        getRequirements(docId),
        tenantId ? getLatestConfig(tenantId) : Promise.reject(new Error("Missing tenant")),
        tenantId ? getAuditTrail(tenantId) : Promise.reject(new Error("Missing tenant")),
      ]);
      setRequirements(reqs);
      setConfigVersion(cfg);
      setAuditEvents(audit);
      setConfigDiff(await getConfigDiff(cfg.id).catch(() => null));
      setIntelligenceState("ready");
      setGovernanceState("ready");
      setMessage("Requirements matched and config loaded.");
    } catch (error) {
      setIntelligenceState("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleRunSimulation() {
    if (!configVersion) {
      setMessage("No config version loaded yet.");
      return;
    }

    setSimulationState("loading");
    setAnimatedStepIndex(-1);
    setMessage("Running simulation trace...");
    try {
      const result = await runSimulation(configVersion.id);
      setSimulation(result);
      setSimulationState("ready");
      setTimelineLog((current: string[]) => [...current, `Simulation completed: ${result.simulation_run_id}`]);
      if (tenantId) {
        const audit = await getAuditTrail(tenantId);
        setAuditEvents(audit);
      }
    } catch (error) {
      setSimulationState("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleApprove(role: "engineer" | "architect", scope: "field_mappings" | "dag" | "full", comment: string) {
    if (!configVersion) {
      setMessage("No config version available for approval.");
      return;
    }

    setGovernanceState("loading");
    try {
      await approveConfig(configVersion.id, {
        role,
        scope,
        comment,
        actor: `${role}_dashboard`,
      });
      setTimelineLog((current) => [...current, `${role} approved ${scope}`]);
      setMessage(`${role} approval saved.`);
      const [cfg, audit, diff] = await Promise.all([
        getLatestConfig(tenantId),
        getAuditTrail(tenantId),
        getConfigDiff(configVersion.id),
      ]);
      setConfigVersion(cfg);
      setAuditEvents(audit);
      setConfigDiff(diff);
      setGovernanceState("ready");
    } catch (error) {
      setGovernanceState("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const finalPayment = simulationTrace.find((step) => step.service_type === "PAYMENT");
  const cibilScore = bureauStep?.output && typeof bureauStep.output === "object"
    ? (bureauStep.output as Record<string, unknown>)?.data && typeof (bureauStep.output as Record<string, unknown>).data === "object"
      ? ((bureauStep.output as Record<string, unknown>).data as Record<string, unknown>).credit_score
      : undefined
    : undefined;

  return (
    <div className="min-h-screen text-slate-100">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.18),transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(251,191,36,0.15),transparent_24%),linear-gradient(180deg,#020617_0%,#0f172a_54%,#020617_100%)]" />
      <header className="mx-auto max-w-[1800px] px-6 pb-6 pt-8 lg:px-8">
        <div className="rounded-[2rem] border border-white/10 bg-white/5 p-6 shadow-glow backdrop-blur-xl">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.42em] text-cyan-200/80">Finspark Command Center</p>
              <h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-5xl">
                Golden Path Demo Dashboard
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
                Upload a BRD, watch PII redaction, requirement matching, governance approvals, and simulation trace execution in one live story.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <StatusPill label={`API ${getApiBaseUrl()}`} tone="cyan" />
              <StatusPill label={`Simulator ${getSimulatorBaseUrl()}`} tone="amber" />
              <StatusPill label={`Status ${configStatus}`} tone={configStatus === "approved" ? "green" : "slate"} />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <span>{message}</span>
            {uploadState === "loading" || pollingState === "loading" || intelligenceState === "loading" || governanceState === "loading" || simulationState === "loading" ? <Spinner /> : null}
          </div>
        </div>
        <div className="mt-5 rounded-[1.8rem] border border-amber-300/30 bg-gradient-to-r from-amber-500/20 via-cyan-500/15 to-emerald-500/20 p-5 shadow-glow">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill label="Executive Insight" tone="amber" />
            <StatusPill label={configStatus} tone={configStatus === "approved" ? "green" : "slate"} />
          </div>
          <p className="mt-3 text-lg font-semibold leading-7 text-amber-50 sm:text-xl">
            {executiveSummary}
          </p>
        </div>
      </header>

      <DashboardErrorBoundary>
      <main className="mx-auto grid max-w-[1800px] grid-cols-1 gap-6 px-6 pb-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_320px] lg:px-8">
        <Panel title="1. Intake" subtitle="Upload a BRD and show the redacted text once the AI service completes." accent="from-cyan-500/10 to-sky-500/5">
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed border-cyan-300/30 bg-slate-950/60 p-6 text-center transition hover:border-cyan-200/50 hover:bg-white/5">
            <input type="file" className="hidden" accept=".txt,.pdf,.docx" onChange={handleUpload} />
            <div className="text-sm font-semibold text-white">Drop BRD here or click to upload</div>
            <div className="mt-1 text-xs text-slate-400">Use the `test_intent.txt` file for the judge flow.</div>
          </label>

          <div className="space-y-2 rounded-3xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>File</span>
              {uploadState === "loading" ? <Spinner /> : selectedFile ? <StatusPill label={selectedFile.name} tone="cyan" /> : <StatusPill label="No file" />}
            </div>
            <div className="text-sm text-slate-200">{document?.filename ?? selectedFile?.name ?? "Waiting for upload"}</div>
            <div className="rounded-2xl bg-slate-950/90 p-4 text-xs leading-6 text-slate-300">
              <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-slate-500">
                <span>Redacted Text</span>
                <span>{document?.parse_status ?? "idle"}</span>
              </div>
              {groundingLines.length > 0 ? (
                <div className="max-h-80 space-y-1 overflow-auto font-mono">
                  {groundingLines.map((line, index) => (
                    <div
                      key={`grounding-line-${index}`}
                      ref={(element) => {
                        lineRefs.current[index] = element;
                      }}
                      className={`rounded-md px-2 py-1 transition ${highlightedLineIndex === index ? "bg-amber-300/35 text-amber-50" : "text-slate-300"}`}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap font-mono">
                  {hasMaskedRedaction
                    ? redactedText
                    : document?.parse_status === "config_generated"
                      ? "No PII detected in this document."
                      : "Waiting for PII redaction..."}
                </pre>
              )}
            </div>
            <button
              type="button"
              className="w-full rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!document?.id}
              onClick={() => document?.id ? void refreshIntel(document.id) : undefined}
            >
              Refresh Intelligence
            </button>
          </div>
        </Panel>

        <Panel title="2. Intelligence" subtitle="Requirements, matched adapter, and explanation from the intent engine." accent="from-indigo-500/10 to-cyan-500/5">
          <div className="flex items-center justify-between">
            <StatusPill label={intelligenceState === "loading" ? "Loading" : `${requirements.length} requirements`} tone={requirements.length > 0 ? "green" : "slate"} />
            {intelligenceState === "loading" ? <Spinner /> : null}
          </div>
          <div className="space-y-3">
            {requirements.length === 0 ? (
              <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-slate-400">Requirements will appear here after polling completes.</div>
            ) : (
              requirements.map((requirement) => (
                <article
                  key={requirement.id}
                  className={`cursor-pointer rounded-3xl border bg-slate-950/80 p-4 transition ${activeRequirementId === requirement.id ? "border-amber-300/60 ring-2 ring-amber-300/30" : "border-white/10 hover:border-cyan-300/40"}`}
                  onClick={() => handleRequirementClick(requirement)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && handleRequirementClick(requirement)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-white">{requirement.service_type}</div>
                      <div className="mt-1 text-xs text-slate-400">{requirement.source_sentence}</div>
                    </div>
                    <StatusPill label={`${Math.round(requirement.confidence * 100)}%`} tone="cyan" />
                  </div>
                  <div className="mt-3 rounded-2xl border border-cyan-300/20 bg-cyan-400/5 p-3 text-xs text-cyan-50">
                    <div className="font-semibold">{requirement.matched_adapter_version_id ? "Matched Adapter" : "Unmatched"}</div>
                    <div className="mt-1 text-slate-200">{requirement.match_explanation ?? "Waiting for semantic match..."}</div>
                    <div className="mt-2 text-slate-400">Adapter Version: {requirement.matched_adapter_version_id ?? "n/a"}</div>
                  </div>
                </article>
              ))
            )}
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-xs text-slate-300">
            <div className="mb-2 font-semibold uppercase tracking-[0.2em] text-slate-400">Judge Proof</div>
            <div>Click any requirement to highlight its source sentence in the redacted text. This proves our AI engine is grounded in document facts, not hallucinating from templates.</div>
          </div>
        </Panel>

        <Panel title="3. Governance" subtitle="Diff view and scoped approvals for mappings, DAG, and full config." accent="from-amber-500/10 to-orange-500/5">
          <div className="flex items-center justify-between">
            <StatusPill label={`Config v${configVersion?.version_number ?? "?"}`} tone="amber" />
            {governanceState === "loading" ? <Spinner /> : null}
          </div>
          <div className="rounded-3xl border border-white/10 bg-slate-950/80 p-4 text-xs text-slate-300">
            <div className="mb-2 font-semibold uppercase tracking-[0.2em] text-slate-400">Config Diff</div>
            <div className="max-h-60 space-y-2 overflow-auto pr-1">
              {humanDiffItems.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-2xl border p-3 ${item.tone === "added" ? "border-emerald-300/30 bg-emerald-300/10" : item.tone === "modified" ? "border-amber-300/30 bg-amber-300/10" : "border-rose-300/30 bg-rose-300/10"}`}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-200">{toneIcon(item.tone)}</div>
                  <div className="mt-1 text-slate-100">{item.text}</div>
                </div>
              ))}
            </div>
            <details className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3">
              <summary className="cursor-pointer text-[11px] uppercase tracking-[0.18em] text-slate-400">Raw JSON Diff</summary>
              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-300">{configDiff ? formatJson(configDiff) : "Diff will appear after a version is loaded."}</pre>
            </details>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-400/20 disabled:opacity-50"
              disabled={!configVersion}
              onClick={() => void handleApprove("engineer", "field_mappings", approval.engineerComment)}
            >
              Approve Field Mappings
            </button>
            <button
              type="button"
              className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm font-semibold text-amber-100 transition hover:bg-amber-400/20 disabled:opacity-50"
              disabled={!configVersion}
              onClick={() => void handleApprove("architect", "full", approval.architectComment)}
            >
              Approve Full Config
            </button>
          </div>

          <label className="block text-xs text-slate-400">
            Engineer comment
            <textarea
              className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950/90 p-3 text-sm text-slate-100 outline-none ring-0 placeholder:text-slate-600"
              rows={3}
              value={approval.engineerComment}
              onChange={(event) => setApproval((current) => ({ ...current, engineerComment: event.target.value }))}
            />
          </label>

          <label className="block text-xs text-slate-400">
            Architect comment
            <textarea
              className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950/90 p-3 text-sm text-slate-100 outline-none ring-0 placeholder:text-slate-600"
              rows={3}
              value={approval.architectComment}
              onChange={(event) => setApproval((current) => ({ ...current, architectComment: event.target.value }))}
            />
          </label>

          <div className="rounded-3xl border border-white/10 bg-white/5 p-3 text-xs text-slate-300">
            <div className="font-semibold">Approval Rules</div>
            <div className="mt-1 text-slate-400">Engineers approve field mappings; architects approve DAG or full config.</div>
          </div>
        </Panel>

        <Panel title="4. Execution" subtitle="Run the deterministic DAG and watch the AI-generated trace pulse left to right." accent="from-emerald-500/10 to-teal-500/5">
          <div className="flex items-center justify-between gap-2">
            <StatusPill label={simulationState === "loading" ? "Running" : simulation?.status ?? "Idle"} tone={simulation?.status === "completed" ? "green" : "slate"} />
            {simulationState === "loading" ? <Spinner /> : null}
          </div>
          <button
            type="button"
            className="w-full rounded-2xl bg-emerald-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!configVersion}
            onClick={() => void handleRunSimulation()}
          >
            Run Simulation
          </button>

          <div className="rounded-3xl border border-white/10 bg-slate-950/90 p-4 text-xs">
            <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-slate-500">
              <span>Simulation Trace</span>
              <span>{simulationTrace.length} steps</span>
            </div>
            <div className="mb-4 rounded-2xl border border-white/10 bg-slate-900/60 p-3">
              <div className="mb-3 text-[11px] uppercase tracking-[0.2em] text-slate-400">Visual Flow</div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
                {flowNodes.map((node, index) => {
                  const state = (flowStates as Record<string, "idle" | "running" | "success" | "failed">)[node.id] ?? "idle";
                  const stateClass = state === "success"
                    ? "border-emerald-300/60 bg-emerald-400/20 text-emerald-50 shadow-[0_0_22px_rgba(16,185,129,0.35)]"
                    : state === "failed"
                      ? "border-rose-300/60 bg-rose-400/20 text-rose-50"
                      : state === "running"
                        ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-50 animate-pulse"
                        : "border-white/15 bg-white/5 text-slate-300";
                  return (
                    <div key={`flow-${node.id}`} className="contents">
                      <div className={`rounded-xl border px-3 py-2 text-center text-[11px] font-semibold transition ${stateClass}`}>
                        {node.label}
                      </div>
                      {index < flowNodes.length - 1 ? (
                        <div className="hidden items-center justify-center text-slate-500 md:flex">→</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="space-y-2 font-mono text-[11px] leading-5 text-slate-300">
              {simulationTrace.length === 0 ? (
                <div className="text-slate-500">The dry run output will appear here.</div>
              ) : (
                simulationTrace.map((step, index) => (
                  <div key={`${step.node_id}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span>{index + 1}. {step.service_type}</span>
                      <StatusPill label={step.status} tone={step.status === "success" ? "green" : step.status === "failed" ? "rose" : "amber"} />
                    </div>
                    <div className="mt-1 text-slate-500">Latency: {step.latency_ms}ms</div>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap text-cyan-100">{formatJson(step.output ?? step.input)}</pre>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-emerald-300/20 bg-emerald-400/5 p-4 text-xs text-slate-200">
            <div className="font-semibold text-emerald-100">Payment Result</div>
            <div className="mt-1">{finalPayment?.status === "success" ? "Razorpay Success message visible in the trace." : "Waiting for payment step..."}</div>
            <div className="mt-2 text-slate-400">CIBIL Score: {typeof cibilScore === "number" ? cibilScore : "n/a"}</div>
          </div>
        </Panel>

        <AuditSidebar events={auditEvents} />
      </main>
      </DashboardErrorBoundary>

      <footer className="mx-auto max-w-[1800px] px-6 pb-10 lg:px-8">
        <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-xs text-slate-400">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Golden Path: Upload → Redact → Match → Approve → Simulate → Audit</span>
            <span>{timelineLog.join(" · ") || "No story events yet."}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}