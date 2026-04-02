type ConfigDiffProps = {
  previousVersion: { version_number: number; config_json: unknown } | null;
  newVersion: {
    version_number: number;
    config_json: any;
    diff_from_previous?: unknown;
  } | null;
  onApprove: (scope: string) => void;
  onReject: (scope: string) => void;
};

export function ConfigDiff({ previousVersion, newVersion, onApprove, onReject }: ConfigDiffProps) {
  const mappings = Array.isArray(newVersion?.config_json?.field_mappings)
    ? newVersion?.config_json?.field_mappings
    : [];

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl bg-ink p-3 text-xs text-sky-200">
          <h3 className="mb-2 font-display text-sm text-white">Version {previousVersion?.version_number ?? "-"} (Active)</h3>
          <pre className="max-h-72 overflow-auto">{JSON.stringify(previousVersion?.config_json ?? {}, null, 2)}</pre>
        </div>
        <div className="rounded-2xl bg-ink p-3 text-xs text-amber-200">
          <h3 className="mb-2 font-display text-sm text-white">Version {newVersion?.version_number ?? "-"} (Draft)</h3>
          <pre className="max-h-72 overflow-auto">{JSON.stringify(newVersion?.config_json ?? {}, null, 2)}</pre>
        </div>
      </div>

      <div className="grid gap-3">
        {mappings.map((mapping: any, index: number) => (
          <div key={`${String(mapping?.source_field ?? "field")}-${index}`} className="rounded-xl bg-ink/5 p-3 text-sm">
            <p className="font-semibold">{String(mapping?.source_field ?? "unknown")} {"->"} {String(mapping?.target_field ?? "unknown")}</p>
            <p className="text-ink/70">{String(mapping?.source_sentence ?? "No source sentence available")}</p>
            <p className="text-ink/70">confidence: {String(mapping?.confidence ?? "n/a")}</p>
            <p className="text-ink/70">review required: {String(mapping?.requires_human_review ?? false)}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          "field_mappings",
          "dag",
          "hooks",
          "full",
        ].map((scope) => (
          <div key={scope} className="flex gap-2">
            <button className="btn-primary" onClick={() => onApprove(scope)}>
              Approve {scope}
            </button>
            <button className="btn-danger" onClick={() => onReject(scope)}>
              Reject {scope}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
