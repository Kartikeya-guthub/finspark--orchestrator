import { useMemo, useState } from "react";
import { ConfigDiff } from "./components/ConfigDiff";

type DiffPayload = {
  current?: {
    id: string;
    version_number: number;
    status: string;
    config_json: unknown;
  };
  previous?: {
    id: string;
    version_number: number;
    config_json: unknown;
  } | null;
  citations?: Array<{ requirement_id?: string; source_sentence?: string }>;
  summary?: Record<string, unknown>;
};

type ApprovalPayload = {
  status: string;
  remaining_roles?: string[];
  partial_approval?: boolean;
  all_approved?: boolean;
  scope?: string;
};

type SimulationPayload = {
  simulation_run_id: string;
  status: string;
  results: unknown;
};

export function App() {
  const [apiBase, setApiBase] = useState("http://127.0.0.1:8000");
  const [jwt, setJwt] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [approverRole, setApproverRole] = useState("architect");
  const [approverUserId, setApproverUserId] = useState("ui-reviewer");
  const [comment, setComment] = useState("");
  const [simulationMode, setSimulationMode] = useState<"schema" | "dryrun" | "mock">("mock");
  const [simulationScenario, setSimulationScenario] = useState<"success" | "partial_failure" | "timeout" | "schema_mismatch">("success");

  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [approvalResult, setApprovalResult] = useState<ApprovalPayload | null>(null);
  const [simulationResult, setSimulationResult] = useState<SimulationPayload | null>(null);
  const [statusText, setStatusText] = useState("Ready");
  const [busy, setBusy] = useState(false);

  const headers = useMemo(
    () => ({
      "Content-Type": "application/json",
      "x-user-role": approverRole.trim().toLowerCase() || "architect",
      "x-user-id": approverUserId.trim() || "ui-reviewer",
      ...(jwt.trim() ? { Authorization: `Bearer ${jwt.trim()}` } : {}),
    }),
    [approverRole, approverUserId, jwt],
  );

  async function loadDiff() {
    if (!versionId.trim()) {
      setStatusText("Enter config version id before loading diff.");
      return;
    }
    setBusy(true);
    setStatusText("Loading config diff...");
    try {
      const response = await fetch(`${apiBase}/api/config-versions/${versionId.trim()}/diff`, { headers });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? `HTTP ${response.status}`);
      }
      setDiff(data);
      setStatusText("Diff loaded.");
    } catch (error) {
      setStatusText(`Diff load failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  async function submitForReview() {
    if (!versionId.trim()) {
      setStatusText("Enter config version id before submitting review.");
      return;
    }
    setBusy(true);
    setStatusText("Submitting config for review...");
    try {
      const response = await fetch(`${apiBase}/api/configs/${versionId.trim()}/submit-review`, {
        method: "POST",
        headers,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? `HTTP ${response.status}`);
      }
      setApprovalResult(data);
      setStatusText(`Submitted. Config is now ${data.status}.`);
    } catch (error) {
      setStatusText(`Submit review failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  async function submitScopedDecision(scope: string, status: "approved" | "rejected") {
    if (!versionId.trim()) {
      setStatusText("Enter config version id before decision.");
      return;
    }
    setBusy(true);
    setStatusText(`Submitting ${status} for ${scope}...`);
    try {
      const path = status === "approved" ? "approve" : "reject";
      const response = await fetch(`${apiBase}/api/configs/${versionId.trim()}/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ scope, comment }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? `HTTP ${response.status}`);
      }
      setApprovalResult({ ...data, scope });
      setStatusText(`Recorded ${status} for ${scope}.`);
    } catch (error) {
      setStatusText(`Decision failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  async function runSimulation() {
    if (!versionId.trim()) {
      setStatusText("Enter config version id before simulation.");
      return;
    }
    setBusy(true);
    setStatusText(`Running ${simulationMode} simulation...`);
    try {
      const response = await fetch(`${apiBase}/api/simulations/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          tenant_config_version_id: versionId.trim(),
          mode: simulationMode,
          scenario: simulationScenario,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? `HTTP ${response.status}`);
      }
      setSimulationResult(data);
      setStatusText(`Simulation complete (${simulationMode}).`);
    } catch (error) {
      setStatusText(`Simulation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-grid p-4 text-ink sm:p-6 lg:p-10">
      <section className="mx-auto max-w-7xl space-y-4">
        <div className="rounded-3xl border border-ink/20 bg-paper p-6 shadow-soft">
          <h1 className="font-display text-3xl leading-tight sm:text-4xl">
            Config Safety, Approval, and Simulation Console
          </h1>
          <p className="mt-2 text-sm text-ink/70">
            Phase 12 safety guard, Phase 13 approval workflow with diff, and Phase 14 three-level simulation.
          </p>
          <p className="mt-3 text-xs uppercase tracking-[0.12em] text-ink/60">{statusText}</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-3xl border border-ink/15 bg-white/90 p-5 shadow-soft">
            <h2 className="font-display text-xl">Session Inputs</h2>
            <div className="mt-4 grid gap-3">
              <label className="text-sm">API Base URL</label>
              <input className="input" value={apiBase} onChange={(event) => setApiBase(event.target.value)} />

              <label className="text-sm">JWT Token</label>
              <input className="input" value={jwt} onChange={(event) => setJwt(event.target.value)} placeholder="Bearer token payload only" />

              <label className="text-sm">Tenant ID</label>
              <input className="input" value={tenantId} onChange={(event) => setTenantId(event.target.value)} />

              <label className="text-sm">Config Version ID</label>
              <input className="input" value={versionId} onChange={(event) => setVersionId(event.target.value)} />

              <div className="flex gap-2">
                <button className="btn-primary" onClick={loadDiff} disabled={busy}>Load Diff</button>
                <button
                  className="btn-secondary"
                  onClick={async () => {
                    if (!tenantId.trim()) {
                      setStatusText("Enter tenant id to load versions.");
                      return;
                    }
                    setBusy(true);
                    try {
                      const response = await fetch(`${apiBase}/api/tenants/${tenantId.trim()}/config/versions`, { headers });
                      const data = await response.json();
                      if (!response.ok) {
                        throw new Error(data?.error ?? `HTTP ${response.status}`);
                      }
                      if (Array.isArray(data?.items) && data.items.length > 0) {
                        setVersionId(String(data.items[0].id ?? ""));
                        setStatusText(`Latest version selected: ${String(data.items[0].id ?? "")}`);
                      } else {
                        setStatusText("No versions found for tenant.");
                      }
                    } catch (error) {
                      setStatusText(`Failed to load versions: ${error instanceof Error ? error.message : "unknown error"}`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  Pick Latest Version
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-ink/15 bg-white/90 p-5 shadow-soft">
            <h2 className="font-display text-xl">Approval Workflow</h2>
            <div className="mt-4 grid gap-3">
              <label className="text-sm">Approver Role</label>
              <input className="input" value={approverRole} onChange={(event) => setApproverRole(event.target.value)} />

              <label className="text-sm">Approver User ID</label>
              <input className="input" value={approverUserId} onChange={(event) => setApproverUserId(event.target.value)} />

              <label className="text-sm">Comment</label>
              <textarea className="input min-h-20" value={comment} onChange={(event) => setComment(event.target.value)} />

              <div className="flex gap-2">
                <button className="btn-secondary" onClick={submitForReview} disabled={busy}>Submit Review</button>
              </div>

              {approvalResult ? (
                <div className="rounded-2xl bg-ink/5 p-3 text-sm">
                  <p>Status: {approvalResult.status}</p>
                  <p>Scope: {approvalResult.scope ?? "n/a"}</p>
                  <p>All approved: {approvalResult.all_approved ? "yes" : "no"}</p>
                  <p>Partial: {approvalResult.partial_approval ? "yes" : "no"}</p>
                  <p>Remaining roles: {approvalResult.remaining_roles?.join(", ") || "n/a"}</p>
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <section className="rounded-3xl border border-ink/15 bg-white/90 p-5 shadow-soft">
          <h2 className="font-display text-xl">Three-Level Simulation</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["schema", "dryrun", "mock"] as const).map((mode) => (
              <button
                key={mode}
                className={simulationMode === mode ? "chip-active" : "chip"}
                onClick={() => setSimulationMode(mode)}
                disabled={busy}
              >
                {mode}
              </button>
            ))}
            {(["success", "partial_failure", "timeout", "schema_mismatch"] as const).map((scenario) => (
              <button
                key={scenario}
                className={simulationScenario === scenario ? "chip-active" : "chip"}
                onClick={() => setSimulationScenario(scenario)}
                disabled={busy}
              >
                {scenario}
              </button>
            ))}
            <button className="btn-primary" onClick={runSimulation} disabled={busy}>Run Simulation</button>
          </div>
          {simulationResult ? (
            <pre className="mt-4 max-h-80 overflow-auto rounded-2xl bg-black p-3 font-mono text-xs text-lime-300">
              {JSON.stringify(simulationResult, null, 2)}
            </pre>
          ) : null}
        </section>

        <section className="rounded-3xl border border-ink/15 bg-white/90 p-5 shadow-soft">
          <h3 className="font-display text-lg">Config Diff and Scoped Decisions</h3>
          <div className="mt-3">
            <ConfigDiff
              previousVersion={diff?.previous ?? null}
              newVersion={diff?.current ?? null}
              onApprove={(scope) => {
                void submitScopedDecision(scope, "approved");
              }}
              onReject={(scope) => {
                void submitScopedDecision(scope, "rejected");
              }}
            />
          </div>
        </section>

        <section className="rounded-3xl border border-ink/15 bg-white/90 p-5 shadow-soft">
          <h3 className="font-display text-lg">Source Sentence Citations</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {(diff?.citations ?? []).slice(0, 12).map((citation, index) => (
              <li key={`${citation.requirement_id ?? "req"}-${index}`} className="rounded-xl bg-ink/5 p-3">
                <p className="font-semibold">{citation.requirement_id ?? "unknown requirement"}</p>
                <p className="text-ink/70">{citation.source_sentence ?? "No sentence citation captured"}</p>
              </li>
            ))}
          </ul>
          <pre className="mt-4 max-h-56 overflow-auto rounded-2xl bg-ink p-3 font-mono text-xs text-rose-200">
            {JSON.stringify(diff?.summary ?? { summary: "No diff summary yet" }, null, 2)}
          </pre>
        </section>
      </section>
    </main>
  );
}
