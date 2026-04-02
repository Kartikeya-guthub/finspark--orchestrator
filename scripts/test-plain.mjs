/**
 * Finspark Orchestrator - Phase Test Runner (ASCII-safe)
 */
import fs from "node:fs";
import path from "node:path";

const API = "http://127.0.0.1:8000";
const AI  = "http://127.0.0.1:8002";

let PASS = 0, FAIL = 0;
const FAILURES = [];
const LOG = [];

function log(msg) { LOG.push(msg); process.stdout.write(msg + "\n"); }
function section(t) { log("\n--- " + t + " ---"); }
function ok(label, val, detail="") {
  const d = detail ? " [" + detail + "]" : "";
  if (val) { log("  PASS: " + label + d); PASS++; }
  else      { log("  FAIL: " + label + d); FAIL++; FAILURES.push(label); }
}
function info(label, detail="") {
  log("  INFO: " + label + (detail ? " - " + detail : ""));
}

async function get(url, headers={}) {
  try {
    const res = await fetch(url, { headers });
    let body; try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  } catch(e) { return { status: 0, body: null, err: e.message }; }
}
async function post(url, body, headers={}, timeoutMs=15000) {
  try {
    const isFormData = body instanceof FormData;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const opts = {
      method: "POST",
      signal: ac.signal,
      headers: isFormData ? headers : { "Content-Type": "application/json", ...headers },
      body: isFormData ? body : JSON.stringify(body),
    };
    const res = await fetch(url, opts);
    clearTimeout(timer);
    let data; try { data = await res.json(); } catch { data = null; }
    return { status: res.status, body: data };
  } catch(e) { return { status: 0, body: null, err: e.message }; }
}

// ------ BRD document (minimal: 1 clear requirement for pipeline speed) ------
const BRD = `BUSINESS REQUIREMENTS DOCUMENT - FinTech Loan Processing

Bureau Integration Requirements:
The platform must fetch CIBIL bureau report for all loan applicants above INR 5 lakh.
CIBIL bureau check is mandatory before loan approval.
Sample Aadhaar: 1234 5678 9012
Sample PAN: ABCDE1234F
Applicant phone: 9876543210
`;

const BRD_PATH = "tmp-brd-test.txt";
fs.writeFileSync(BRD_PATH, BRD);

let TENANT_A_ID="", TENANT_B_ID="";
let TENANT_A_JWT="", TENANT_B_JWT="";
let TENANT_A_KEY="";
let DOC_ID="";

// ========================
// PHASE 1 - Health Checks
// ========================
section("PHASE 1 - Infrastructure Health");

const apiH = await get(`${API}/health`);
ok("API /health = 200", apiH.status === 200, "status="+apiH.status);
ok("API health body = ok", apiH.body?.status === "ok");

const aiH = await get(`${AI}/health`);
ok("AI /health = 200", aiH.status === 200, "status="+aiH.status);
ok("AI health body = ok", aiH.body?.status === "ok");

// ========================
// PHASE 2 - Schema check
// ========================
section("PHASE 2 - Postgres Schema via adapter endpoint");

const allAdaptersRes = await get(`${API}/api/adapters`);
ok("GET /api/adapters = 200", allAdaptersRes.status === 200);
ok("adapters.items is array", Array.isArray(allAdaptersRes.body?.items));
ok("adapters.count is number", typeof allAdaptersRes.body?.count === "number");

// ========================
// PHASE 3 - Seed Data
// ========================
section("PHASE 3 - Seed Data (Adapter Registry)");

const ALL = allAdaptersRes.body?.items ?? [];
ok("15+ adapters seeded", ALL.length >= 15, "count="+ALL.length);

const CATS = [...new Set(ALL.map(a => a.category))];
for (const c of ["bureau","kyc","gst","payment","fraud","open_banking"]) {
  ok("Category '"+c+"' exists", CATS.includes(c));
}

const bureauRes = await get(`${API}/api/adapters/bureau`);
ok("GET /api/adapters/bureau = 200", bureauRes.status === 200);
ok("bureau has CIBIL adapter", (bureauRes.body?.items ?? []).some(a => a.name?.toLowerCase().includes("cibil")));
ok("All bureau adapters have versions", (bureauRes.body?.items ?? []).every(a => Array.isArray(a.versions)));

const withV = ALL.filter(a => (a.versions?.length ?? 0) > 0);
ok("10+ adapters have versions", withV.length >= 10, withV.length+"/"+ ALL.length);

// ========================
// PHASE 4 - Tenant + Secrets
// ========================
section("PHASE 4 - Tenant Bootstrap, Middleware, Secrets");

const bootA = await post(`${API}/api/tenants/bootstrap`,
  { tenant_name: "TenantA_"+Date.now(), created_by: "test-runner" });
ok("Bootstrap Tenant A = 201", bootA.status === 201, "status="+bootA.status);
ok("Tenant A has id", !!bootA.body?.tenant?.id);
ok("Tenant A has jwt", !!bootA.body?.credentials?.jwt);
ok("Tenant A has api_key", !!bootA.body?.credentials?.api_key);
ok("Default config uses vault:// ref",
  bootA.body?.default_config?.config_json?.service_credentials?.cibil_api_key?.startsWith("vault://"));
TENANT_A_ID  = bootA.body?.tenant?.id ?? "";
TENANT_A_JWT = bootA.body?.credentials?.jwt ?? "";
TENANT_A_KEY = bootA.body?.credentials?.api_key ?? "";

const bootB = await post(`${API}/api/tenants/bootstrap`,
  { tenant_name: "TenantB_"+Date.now(), created_by: "test-runner" });
ok("Bootstrap Tenant B = 201", bootB.status === 201);
TENANT_B_ID  = bootB.body?.tenant?.id ?? "";
TENANT_B_JWT = bootB.body?.credentials?.jwt ?? "";

// Bad body -> 400
const bootBad = await post(`${API}/api/tenants/bootstrap`, {});
ok("Missing tenant_name -> 400", bootBad.status === 400);

// Auth checks
const unauth = await get(`${API}/api/documents`);
ok("No auth -> 401", unauth.status === 401);

const badJwt = await get(`${API}/api/documents`, { Authorization: "Bearer bad.jwt.token" });
ok("Invalid JWT -> 401", badJwt.status === 401);

const validJwt = await get(`${API}/api/documents`, { Authorization: "Bearer "+TENANT_A_JWT });
ok("Valid JWT -> 200", validJwt.status === 200);

const apiKeyAuth = await get(`${API}/api/documents`, { "x-api-key": TENANT_A_KEY });
ok("Valid API Key -> 200", apiKeyAuth.status === 200);

// Secrets refs
const refsRes = await get(`${API}/api/secrets/refs`, { Authorization: "Bearer "+TENANT_A_JWT });
ok("GET /api/secrets/refs = 200", refsRes.status === 200);
const refs = refsRes.body?.items ?? [];
ok("Secrets refs exist", refs.length >= 1, "count="+refs.length);
ok("All refs use vault:// paths", refs.every(r => r.vault_path?.startsWith("vault://")));
ok("No raw values in refs response", refs.every(r => !r.encrypted_value && !r.value));

// Cross-tenant config access -> 403
const crossCfg = await get(`${API}/api/tenants/${TENANT_A_ID}/config/current`,
  { Authorization: "Bearer "+TENANT_B_JWT });
ok("Tenant B cannot read Tenant A config -> 403", crossCfg.status === 403);

// Own config
const ownCfg = await get(`${API}/api/tenants/${TENANT_A_ID}/config/current`,
  { Authorization: "Bearer "+TENANT_A_JWT });
ok("Tenant A reads own config = 200", ownCfg.status === 200);
ok("Initial config version = 1", ownCfg.body?.version_number === 1);

// ========================
// PHASE 5 - Document Upload
// ========================
section("PHASE 5 - Document Upload, Fingerprint, Dedup");

const brdBytes = fs.readFileSync(BRD_PATH);

// First upload
const fd1 = new FormData();
fd1.append("file", new Blob([brdBytes],{type:"text/plain"}), "brd.txt");
const up1 = await post(`${API}/api/documents/upload`, fd1,
  { Authorization: "Bearer "+TENANT_A_JWT });
ok("First upload = 201", up1.status === 201, "status="+up1.status+" body="+JSON.stringify(up1.body));
ok("Returns document_id", !!up1.body?.document_id);
ok("Status = queued", up1.body?.status === "queued");
DOC_ID = up1.body?.document_id ?? "";

// Idempotent re-upload
const fd2 = new FormData();
fd2.append("file", new Blob([brdBytes],{type:"text/plain"}), "brd.txt");
const up2 = await post(`${API}/api/documents/upload`, fd2,
  { Authorization: "Bearer "+TENANT_A_JWT });
ok("Re-upload same file = 200 (dedup)", up2.status === 200, "status="+up2.status);
ok("Same document_id returned", up2.body?.document_id === DOC_ID);
ok("Status = existing", up2.body?.status === "existing");

// Unsupported file type
const fd3 = new FormData();
fd3.append("file", new Blob(["png"],{type:"image/png"}), "photo.png");
const up3 = await post(`${API}/api/documents/upload`, fd3,
  { Authorization: "Bearer "+TENANT_A_JWT });
ok("Unsupported type -> 400", up3.status === 400);
ok("Error key = unsupported_file_type", up3.body?.error === "unsupported_file_type");

// Modified file -> new doc
const fd4 = new FormData();
const modified = BRD + "\nAppendix: modified at "+Date.now();
fd4.append("file", new Blob([modified],{type:"text/plain"}), "brd-v2.txt");
const up4 = await post(`${API}/api/documents/upload`, fd4,
  { Authorization: "Bearer "+TENANT_A_JWT });
ok("Modified file -> new doc_id", up4.body?.document_id !== DOC_ID);
ok("Modified file -> queued", up4.body?.status === "queued");

// List docs
const listA = await get(`${API}/api/documents`, { Authorization: "Bearer "+TENANT_A_JWT });
ok("GET /api/documents = 200", listA.status === 200);
ok("At least 2 docs for Tenant A", (listA.body?.items?.length ?? 0) >= 2, "count="+(listA.body?.items?.length ?? 0));

// Cross-tenant isolation
const listB = await get(`${API}/api/documents`, { Authorization: "Bearer "+TENANT_B_JWT });
ok("Tenant B doc list is empty", listB.body?.items?.length === 0);

// Get specific doc
const getDoc = await get(`${API}/api/documents/${DOC_ID}`,
  { Authorization: "Bearer "+TENANT_A_JWT });
ok("GET /api/documents/:id = 200", getDoc.status === 200);
ok("Doc has parse_status", !!getDoc.body?.parse_status);
ok("Doc filename correct", getDoc.body?.filename === "brd.txt");

// Cross-tenant doc access
const crossDoc = await get(`${API}/api/documents/${DOC_ID}`,
  { Authorization: "Bearer "+TENANT_B_JWT });
ok("Cross-tenant doc access -> 403", crossDoc.status === 403);

// 404 on unknown doc
const noDoc = await get(`${API}/api/documents/00000000-0000-0000-0000-000000000000`,
  { Authorization: "Bearer "+TENANT_A_JWT });
ok("Unknown doc ID -> 404", noDoc.status === 404);

// ========================
// PHASE 6-11 - AI Pipeline
// ========================
section("PHASE 6-11 - Full AI Pipeline (calling /process-document)");
log("  INFO: Calling POST /process-document, waiting up to 600s (LLM chains)...");

const procRes = await post(`${AI}/process-document`, {
  documentId: DOC_ID,
  tenantId: TENANT_A_ID,
  objectPath: `tenants/${TENANT_A_ID}/docs/${DOC_ID}/brd.txt`,
  filename: "brd.txt",
  contentType: "text/plain",
}, {}, 600000);

const PR = procRes.body ?? {};
if (procRes.status === 0) log("  INFO: /process-document fetch error: " + procRes.err);
ok("POST /process-document = 200", procRes.status === 200, "status="+procRes.status+" pr="+JSON.stringify(PR).slice(0,200));
ok("Response document_id matches", PR.document_id === DOC_ID);
ok("Response tenant_id matches",   PR.tenant_id  === TENANT_A_ID);

// PHASE 6 - PII Redaction
section("PHASE 6 - PII Redaction (Raw Text)");
const ents = PR.entities_found ?? [];
ok("entities_found is array", Array.isArray(ents));
const entTypes = ents.map(e => e.type);
ok("Aadhaar detected & redacted", entTypes.includes("aadhaar"), "found="+JSON.stringify(entTypes));
ok("PAN detected & redacted",     entTypes.includes("pan"));
ok("Phone detected & redacted",   entTypes.includes("phone"));
ok("Each entity has count",       ents.every(e => typeof e.count === "number"));

// PHASE 7 - OCR Structure
section("PHASE 7 - Document Structure Extraction");
const src = PR.structure_source ?? "";
ok("structure_source returned", !!src, src);
ok("Source is valid (heuristic or ocdrnet)",
  src === "heuristic_extraction" || src === "nvidia_ocdrnet", src);

// PHASE 8 - Structured PII
section("PHASE 8 - Structured PII Redaction");
const sEnts = PR.structured_entities_found ?? [];
ok("structured_entities_found is array", Array.isArray(sEnts));
info("Structured PII entities", JSON.stringify(sEnts));

// PHASE 9 - Requirements extraction
section("PHASE 9 - Requirement Extraction (mistral-small)");
ok("requirements_count is number", typeof PR.requirements_count === "number");
ok("At least 1 requirement extracted", PR.requirements_count >= 1, "count="+PR.requirements_count);
ok("extraction_confidence is number", typeof PR.extraction_confidence === "number");
ok("extraction_confidence in [0,1]",
  PR.extraction_confidence >= 0 && PR.extraction_confidence <= 1, "val="+PR.extraction_confidence);

// Verify audit trail
const auditRes = await get(`${API}/api/audit-events`,
  { Authorization: "Bearer "+TENANT_A_JWT });
ok("GET /api/audit-events = 200", auditRes.status === 200);
const AUD = auditRes.body?.items ?? [];
const ACTS = AUD.map(e => e.action);
ok("Audit: pii_redaction event exists",            ACTS.includes("pii_redaction"));
ok("Audit: structure_extraction event exists",     ACTS.includes("structure_extraction"));
ok("Audit: pii_redaction_structured event exists", ACTS.includes("pii_redaction_structured"));
ok("Audit: requirement_extraction event exists",   ACTS.includes("requirement_extraction"));

const reqAudit = AUD.find(e => e.action === "requirement_extraction");
ok("requirement_extraction audit has count in .after",
  typeof reqAudit?.after?.requirements_count === "number",
  JSON.stringify(reqAudit?.after));

// PHASE 10 - Matching
section("PHASE 10 - Embedding + Adapter Matching");
ok("config_version_id returned (matching ran)", !!PR.config_version_id, "id="+PR.config_version_id);

// PHASE 11 - Config generation
section("PHASE 11 - Config Generation + Versioning");
ok("config_version_number returned", typeof PR.config_version_number === "number", "v="+PR.config_version_number);
ok("config_version_number >= 1", PR.config_version_number >= 1);

const cfgAud = AUD.find(e => e.action === "config_generation");
ok("Audit: config_generation event exists", !!cfgAud);
ok("config_generation audit has requirements_count",
  typeof cfgAud?.after?.requirements_count === "number", JSON.stringify(cfgAud?.after));
ok("config_generation audit has match_results array",
  Array.isArray(cfgAud?.after?.match_results));

// Verify versioned config structure via API
const latestCfg = await get(`${API}/api/tenants/${TENANT_A_ID}/config/current`,
  { Authorization: "Bearer "+TENANT_A_JWT });
ok("Tenant config/current = 200 after pipeline", latestCfg.status === 200);
const CJ = latestCfg.body?.config_json;
ok("config_json has field_mappings array", Array.isArray(CJ?.field_mappings));
ok("config_json has dag.nodes array",      Array.isArray(CJ?.dag?.nodes));
ok("config_json has dag.edges key",        "edges" in (CJ?.dag ?? {}));
ok("config_json has match_results",        Array.isArray(CJ?.match_results));
ok("At least 1 field mapping",   (CJ?.field_mappings?.length ?? 0) >= 1, "count="+(CJ?.field_mappings?.length ?? 0));
ok("At least 1 DAG node",        (CJ?.dag?.nodes?.length ?? 0) >= 1,    "count="+(CJ?.dag?.nodes?.length ?? 0));

const FM = CJ?.field_mappings?.[0];
if (FM) {
  ok("field_mapping[0] has source_field",       !!FM.source_field);
  ok("field_mapping[0] has target_field",       !!FM.target_field);
  ok("field_mapping[0] has transformation_rule",!!FM.transformation_rule);
  ok("field_mapping[0] confidence in [0,1]",    FM.confidence >= 0 && FM.confidence <= 1, "val="+FM.confidence);
  ok("field_mapping[0] has requires_human_review", typeof FM.requires_human_review === "boolean");
}

const DN = CJ?.dag?.nodes?.[0];
if (DN) {
  ok("dag_node[0] has node_type",   !!DN.node_type);
  ok("dag_node[0] has retry_policy",typeof DN.retry_policy === "object");
  ok("dag_node[0] has timeout_ms",  typeof DN.timeout_ms === "number");
}

// Version check: config is version number >= 1 (verified from Phase 11 above)
section("PHASE 11b - Version Numbers");
ok("Config version stored as integer", Number.isInteger(PR.config_version_number ?? undefined) || PR.config_version_number === undefined, "v="+PR.config_version_number);

// ========================
// SECURITY TESTS
// ========================
section("SECURITY - Cross-tenant Isolation & Edge Cases");

// Cross-tenant secret resolve
const crossSec = await get(
  `${API}/api/secrets/resolve?path=vault://${TENANT_A_ID}/cibil-prod-key`,
  { Authorization: "Bearer "+TENANT_B_JWT });
ok("Cross-tenant secret resolve -> 403/404",
  crossSec.status === 403 || crossSec.status === 404, "status="+crossSec.status);

// No raw secrets in config response
const cfgStr = JSON.stringify(latestCfg.body ?? {});
const hasRawKey = /nvapi-|sk-live-/.test(cfgStr);
ok("No raw API keys in config response", !hasRawKey);

// Audit events scoped to tenant
const auditA_count = AUD.length;
const auditB = await get(`${API}/api/audit-events`,
  { Authorization: "Bearer "+TENANT_B_JWT });
ok("Audit events scoped per tenant", (auditB.body?.items?.length ?? 0) < auditA_count || auditA_count === 0);

// ========================
// FINAL SUMMARY
// ========================
section("TEST SUMMARY");
log("  Passed : " + PASS);
log("  Failed : " + FAIL);
log("  Total  : " + (PASS+FAIL));

if (FAILURES.length) {
  log("\nFailed assertions:");
  for (const f of FAILURES) log("  - " + f);
}

log("\nPhase coverage:");
log("  Phase  1 - Health checks (API + AI-service)");
log("  Phase  2 - Postgres schema (domain model verification)");
log("  Phase  3 - Seed data / adapter registry (15+ adapters, 6 categories)");
log("  Phase  4 - Tenant middleware (JWT, API key, cross-tenant 403)");
log("  Phase  5 - Document upload (SHA-256 dedup, file validation)");
log("  Phase  6 - PII redaction raw text (Aadhaar, PAN, phone)");
log("  Phase  7 - OCR / structure extraction");
log("  Phase  8 - Structured PII redaction (gliner-pii / regex fallback)");
log("  Phase  9 - AI requirement extraction (mistral + stub fallback)");
log("  Phase 10 - Embedding + adapter matching (semantic+rerank)");
log("  Phase 11 - Config generation + versioned output + DAG");

try { fs.unlinkSync(BRD_PATH); } catch {}

process.exit(FAIL > 0 ? 1 : 0);
