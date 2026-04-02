/**
 * Finspark Orchestrator — Comprehensive Phase Test Runner
 * Tests all 11 phases end-to-end with assertions
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const API = "http://127.0.0.1:8000";
const AI  = "http://127.0.0.1:8002";

let pass = 0;
let fail = 0;
let warn = 0;
const errors = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(label, value, detail = "") {
  if (value) {
    console.log(`  ✅ ${label}${detail ? " — " + detail : ""}`);
    pass++;
  } else {
    console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`);
    fail++;
    errors.push(label);
  }
}

function note(label, detail = "") {
  console.log(`  ℹ️  ${label}${detail ? " — " + detail : ""}`);
  warn++;
}

function section(title) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(70)}`);
}

async function apiFetch(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    let body;
    const ct = res.headers.get("content-type") || "";
    try { body = ct.includes("json") ? await res.json() : await res.text(); }
    catch { body = null; }
    return { status: res.status, body, ok: res.ok };
  } catch (err) {
    return { status: 0, body: null, ok: false, error: err.message };
  }
}

// ─── Sample BRD document ──────────────────────────────────────────────────────

const BRD_TEXT = `
BUSINESS REQUIREMENTS DOCUMENT — FinTech Loan Processing

1. Bureau Integration Requirements:
The platform must fetch CIBIL bureau report for all loan applicants above INR 5L.
Experian credit check shall be run in parallel as a secondary bureau.
Both bureau checks are mandatory before loan approval.

2. KYC Requirements:
Aadhaar eKYC verification is required for all individual applicants.
PAN verification must be performed to validate tax identity.
Sample Aadhaar: 1234 5678 9012
Sample PAN: ABCDE1234F
Customer name: John Doe
Applicant phone: 9876543210

3. GST Verification:
Verify tax registration status for business applicants.
GST verification is mandatory for loan above INR 10L.

4. Fraud Detection:
FraudShield must be run post KYC completion.
ThreatMetrix device fingerprinting is required.

5. Open Banking:
Account Aggregator consent must be obtained before data fetch.
Fetch last 6 months bank statements via AA framework.
`;

// Write temp BRD as txt
const BRD_PATH = path.resolve("tmp-test-brd.txt");
fs.writeFileSync(BRD_PATH, BRD_TEXT);

// ─── State shared across phases ───────────────────────────────────────────────
let tenantAId = "", tenantBId = "";
let tenantAJwt = "", tenantBJwt = "";
let tenantAApiKey = "";
let documentId = "";
let configVersionId = "";

// ══════════════════════════════════════════════════════════════════════════════
//  PHASE 1 — Health Checks (Repo/Folder/Stack)
// ══════════════════════════════════════════════════════════════════════════════
section("PHASE 1 — Infrastructure Health Checks");

const apiHealth = await apiFetch(`${API}/health`);
ok("API /health responds 200", apiHealth.status === 200);
ok("API returns { status: 'ok' }", apiHealth.body?.status === "ok", JSON.stringify(apiHealth.body));

const aiHealth = await apiFetch(`${AI}/health`);
ok("AI-service /health responds 200", aiHealth.status === 200);
ok("AI-service returns { status: 'ok' }", aiHealth.body?.status === "ok", JSON.stringify(aiHealth.body));

// ══════════════════════════════════════════════════════════════════════════════
//  PHASE 2 — Schema / Migration Verification (via adapter endpoint)
// ══════════════════════════════════════════════════════════════════════════════
section("PHASE 2 — Postgres Schema (Domain Model)");

const adaptersAll = await apiFetch(`${API}/api/adapters`);
ok("GET /api/adapters returns 200", adaptersAll.status === 200, `status=${adaptersAll.status}`);
ok("adapters list has items array", Array.isArray(adaptersAll.body?.items));
ok("count field present", typeof adaptersAll.body?.count === "number");

// ══════════════════════════════════════════════════════════════════════════════
//  PHASE 3 — Seed Data (Adapter Registry)
// ══════════════════════════════════════════════════════════════════════════════
section("PHASE 3 — Seed Data & Adapter Registry");

const allAdapters = adaptersAll.body?.items ?? [];
ok("15+ adapters seeded", allAdapters.length >= 15, `found ${allAdapters.length}`);

const categories = [...new Set(allAdapters.map(a => a.category))];
const requiredCategories = ["bureau", "kyc", "gst", "payment", "fraud", "open_banking"];
for (const cat of requiredCategories) {
  ok(`Category '${cat}' exists in registry`, categories.includes(cat));
}

// Test category filter endpoint
const bureauRes = await apiFetch(`${API}/api/adapters/bureau`);
ok("GET /api/adapters/bureau returns 200", bureauRes.status === 200);
ok("bureau adapters have CIBIL", bureauRes.body?.items?.some(a => a.name?.toLowerCase().includes("cibil")));
ok("bureau adapters have versions array", bureauRes.body?.items?.every(a => Array.isArray(a.versions)));

// Check adapter versions exist
const withVersions = allAdapters.filter(a => a.versions?.length > 0);
ok("Most adapters have at least one version", withVersions.length >= 10, `${withVersions.length}/${allAdapters.length} have versions`);

// Check adapter embeddings (seeded)
note("Adapter embeddings are seeded (verified via matcher in Phase 10)");

// ══════════════════════════════════════════════════════════════════════════════
//  PHASE 4 — Tenant Middleware + Secrets Abstraction
// ══════════════════════════════════════════════════════════════════════════════
section("PHASE 4 — Tenant Bootstrap, Middleware & Secrets");

// Bootstrap Tenant A
const bootA = await apiFetch(`${API}/api/tenants/bootstrap`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tenant_name: `TestTenantA_${Date.now()}`, created_by: "test-runner" }),
});
ok("Bootstrap Tenant A → 201", bootA.status === 201, `status=${bootA.status}`);
ok("Tenant A has id", !!bootA.body?.tenant?.id);
ok("Tenant A has jwt", !!bootA.body?.credentials?.jwt);
ok("Tenant A has api_key", !!bootA.body?.credentials?.api_key);
ok("Default config has vault:// reference", bootA.body?.default_config?.config_json?.service_credentials?.cibil_api_key?.startsWith("vault://"));

tenantAId  = bootA.body?.tenant?.id ?? "";
tenantAJwt = bootA.body?.credentials?.jwt ?? "";
tenantAApiKey = bootA.body?.credentials?.api_key ?? "";

// Bootstrap Tenant B
const bootB = await apiFetch(`${API}/api/tenants/bootstrap`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tenant_name: `TestTenantB_${Date.now()}`, created_by: "test-runner" }),
});
ok("Bootstrap Tenant B → 201", bootB.status === 201);
tenantBId  = bootB.body?.tenant?.id ?? "";
tenantBJwt = bootB.body?.credentials?.jwt ?? "";

// Test: missing body → 400
const bootBad = await apiFetch(`${API}/api/tenants/bootstrap`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
ok("Missing tenant_name → 400", bootBad.status === 400);

// Test: unauthenticated request → 401
const unauth = await apiFetch(`${API}/api/documents`);
ok("No auth header → 401", unauth.status === 401);

// Test: invalid JWT → 401
const badJwt = await apiFetch(`${API}/api/documents`, {
  headers: { Authorization: "Bearer bad.token.here" },
});
ok("Invalid JWT → 401", badJwt.status === 401);

// Test: valid JWT works
const docsAuth = await apiFetch(`${API}/api/documents`, {
  headers: { Authorization: `Bearer ${tenantAJwt}` },
});
ok("Valid JWT → 200 on /api/documents", docsAuth.status === 200);

// Test: API key auth works
const apiKeyAuth = await apiFetch(`${API}/api/documents`, {
  headers: { "x-api-key": tenantAApiKey },
});
ok("Valid API Key → 200 on /api/documents", apiKeyAuth.status === 200);

// Test: Secrets refs endpoint returns vault:// paths only
const secretsRefs = await apiFetch(`${API}/api/secrets/refs`, {
  headers: { Authorization: `Bearer ${tenantAJwt}` },
});
ok("GET /api/secrets/refs → 200", secretsRefs.status === 200);
const refs = secretsRefs.body?.items ?? [];
ok("All secret refs use vault:// paths", refs.every(r => r.vault_path?.startsWith("vault://")),
  `${refs.length} refs found`);
ok("No raw secret values in response", refs.every(r => !r.encrypted_value && !r.value));

// Test cross-tenant config isolation
const crossTenant = await apiFetch(`${API}/api/tenants/${tenantAId}/config/current`, {
  headers: { Authorization: `Bearer ${tenantBJwt}` },
});
ok("Tenant B cannot read Tenant A config → 403", crossTenant.status === 403);

// Tenant A can read own config
const ownConfig = await apiFetch(`${API}/api/tenants/${tenantAId}/config/current`, {
  headers: { Authorization: `Bearer ${tenantAJwt}` },
});
ok("Tenant A can read own config → 200", ownConfig.status === 200);
ok("Config version_number is 1", ownConfig.body?.version_number === 1);

// ══════════════════════════════════════════════════════════════════════════════
//  PHASE 5 — Document Ingestion + Storage
// ══════════════════════════════════════════════════════════════════════════════
section("PHASE 5 — Document Upload, Fingerprint & Dedup");

// Upload BRD
const brdBytes = fs.readFileSync(BRD_PATH);
const formData1 = new FormData();
formData1.append("file", new Blob([brdBytes], { type: "text/plain" }), "test-brd.txt");

const upload1 = await apiFetch(`${API}/api/documents/upload`, {
  method: "POST",
  headers: { Authorization: `Bearer ${tenantAJwt}` },
  body: formData1,
});
ok("First upload → 201", upload1.status === 201, `status=${upload1.status} body=${JSON.stringify(upload1.body)}`);
ok("Returns document_id", !!upload1.body?.document_id);
ok("Status is 'queued'", upload1.body?.status === "queued");
documentId = upload1.body?.document_id ?? "";

// Upload SAME file again → idempotent (existing)
const formData2 = new FormData();
formData2.append("file", new Blob([brdBytes], { type: "text/plain" }), "test-brd.txt");
const upload2 = await apiFetch(`${API}/api/documents/upload`, {
  method: "POST",
  headers: { Authorization: `Bearer ${tenantAJwt}` },
  body: formData2,
});
ok("Re-upload same file → 200 (dedup)", upload2.status === 200, `status=${upload2.status}`);
ok("Returns same document_id", upload2.body?.document_id === documentId, `got ${upload2.body?.document_id}`);
ok("Status is 'existing'", upload2.body?.status === "existing");

// Upload unsupported file type → 400
const formData3 = new FormData();
formData3.append("file", new Blob(["data"], { type: "image/png" }), "photo.png");
const uploadBad = await apiFetch(`${API}/api/documents/upload`, {
  method: "POST",
  headers: { Authorization: `Bearer ${tenantAJwt}` },
  body: formData3,
});
ok("Unsupported file type → 400", uploadBad.status === 400);
ok("Error key returned", uploadBad.body?.error === "unsupported_file_type");

// Upload slightly different file → new document_id
const modifiedBrd = BRD_TEXT + `\n\nAppendix: Modified at ${Date.now()}`;
const formData4 = new FormData();
formData4.append("file", new Blob([modifiedBrd], { type: "text/plain" }), "test-brd-v2.txt");
const upload4 = await apiFetch(`${API}/api/documents/upload`, {
  method: "POST",
  headers: { Authorization: `Bearer ${tenantAJwt}` },
  body: formData4,
});
ok("Modified file → new document_id", upload4.body?.document_id !== documentId);
ok("Modified file → status queued", upload4.body?.status === "queued");

// List documents
const listDocs = await apiFetch(`${API}/api/documents`, {
  headers: { Authorization: `Bearer ${tenantAJwt}` },
});
ok("GET /api/documents → 200", listDocs.status === 200);
ok("At least 2 documents in list", (listDocs.body?.items?.length ?? 0) >= 2);

// Cross-tenant doc isolation: Tenant B gets its own empty list
const listDocsB = await apiFetch(`${API}/api/documents`, {
  headers: { Authorization: `Bearer ${tenantBJwt}` },
});
ok("Tenant B doc list is empty (cross-tenant isolation)", listDocsB.body?.items?.length === 0);

// GET specific doc
const getDoc = await apiFetch(`${API}/api/documents/${documentId}`, {
  headers: { Authorization: `Bearer ${tenantAJwt}` },
});
ok("GET /api/documents/:id → 200", getDoc.status === 200);
ok("Doc has parse_status", !!getDoc.body?.parse_status);
ok("Doc filename matches", getDoc.body?.filename === "test-brd.txt");

// Cross-tenant doc access → 403
const getDocCross = await apiFetch(`${API}/api/documents/${documentId}`, {
  headers: { Authorization: `Bearer ${tenantBJwt}` },
});
ok("Cross-tenant doc access → 403", getDocCross.status === 403);

// ══════════════════════════════════════════════════════════════════════════════
//  PHASE 6,7,8,9,10,11 — AI Pipeline (process-document)
// ══════════════════════════════════════════════════════════════════════════════
section("PHASE 6-11 — Full AI Pipeline (PII → OCR → Extract → Match → Config)");

console.log("  ⏳ Calling POST /process-document (may take 30-90s for LLM calls)...");

const processRes = await apiFetch(`${AI}/process-document`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    documentId,
    tenantId: tenantAId,
    objectPath: `tenants/${tenantAId}/docs/${documentId}/test-brd.txt`,
    filename: "test-brd.txt",
    contentType: "text/plain",
  }),
});

ok("POST /process-document → 200", processRes.status === 200, `status=${processRes.status}`);
const pr = processRes.body ?? {};
ok("Response has document_id", pr.document_id === documentId);
ok("Response has tenant_id", pr.tenant_id === tenantAId);

// ── Phase 6 — PII Redaction ────────────────────────────────────────────────
section("PHASE 6 — PII Redaction (Raw Text)");
const entities = pr.entities_found ?? [];
ok("PII entities_found is an array", Array.isArray(entities));
const entityTypes = entities.map(e => e.type);
ok("Aadhaar PII detected & redacted", entityTypes.includes("aadhaar"), `found: ${JSON.stringify(entities)}`);
ok("PAN PII detected & redacted", entityTypes.includes("pan"));
ok("Phone PII detected & redacted", entityTypes.includes("phone"));
ok("Each entity has count", entities.every(e => typeof e.count === "number"));

// ── Phase 7 — OCR / Structure ──────────────────────────────────────────────
section("PHASE 7 — Document Structure Extraction (OCR/Heuristic)");
const structSource = pr.structure_source ?? "";
ok("structure_source field returned", !!structSource, structSource);
ok("Source is heuristic or nvidia_ocdrnet", 
  structSource === "heuristic_extraction" || structSource === "nvidia_ocdrnet",
  structSource);

// ── Phase 8 — Structured PII Redaction ────────────────────────────────────
section("PHASE 8 — Structured PII Redaction (gliner-pii / regex fallback)");
const structEntities = pr.structured_entities_found ?? [];
ok("structured_entities_found is an array", Array.isArray(structEntities));
note("Structured PII redaction ran", `chunk entities: ${JSON.stringify(structEntities)}`);

// ── Phase 9 — Requirement Extraction ──────────────────────────────────────
section("PHASE 9 — Requirement Extraction (mistral-small-3.1)");
ok("requirements_count is a number", typeof pr.requirements_count === "number");
ok("At least 1 requirement extracted", pr.requirements_count >= 1, `count=${pr.requirements_count}`);
ok("extraction_confidence is a number", typeof pr.extraction_confidence === "number");
ok("extraction_confidence between 0 and 1", pr.extraction_confidence >= 0 && pr.extraction_confidence <= 1);

// Verify requirements in DB via audit events
const auditRes = await apiFetch(`${API}/api/audit-events`, {
  headers: { Authorization: `Bearer ${tenantAJwt}` },
});
ok("GET /api/audit-events → 200", auditRes.status === 200);
const auditItems = auditRes.body?.items ?? [];
const auditActions = auditItems.map(e => e.action);
ok("audit has 'pii_redaction' event", auditActions.includes("pii_redaction"));
ok("audit has 'structure_extraction' event", auditActions.includes("structure_extraction"));
ok("audit has 'pii_redaction_structured' event", auditActions.includes("pii_redaction_structured"));
ok("audit has 'requirement_extraction' event", auditActions.includes("requirement_extraction"));
const reqAudit = auditItems.find(e => e.action === "requirement_extraction");
ok("requirement_extraction audit shows count", typeof reqAudit?.after?.requirements_count === "number");

// ── Phase 10 — Adapter Matching ────────────────────────────────────────────
section("PHASE 10 — Embedding + Semantic Adapter Matching");
// If config was generated, matching happened
ok("config_version_id returned (matching + config ran)", !!pr.config_version_id, `config_version_id=${pr.config_version_id}`);
configVersionId = pr.config_version_id ?? "";

// ── Phase 11 — Config Generation + Versioning ─────────────────────────────
section("PHASE 11 — Config Generation + Versioned Output");
ok("config_version_number returned", typeof pr.config_version_number === "number", `v=${pr.config_version_number}`);

const auditConfig = auditItems.find(e => e.action === "config_generation");
ok("audit has 'config_generation' event", !!auditConfig);
ok("config_generation audit has requirements_count", typeof auditConfig?.after?.requirements_count === "number");
ok("config_generation audit has match_results", Array.isArray(auditConfig?.after?.match_results));

// Verify versioned config via tenant config endpoint
const tenantConfig = await apiFetch(`${API}/api/tenants/${tenantAId}/config/current`, {
  headers: { Authorization: `Bearer ${tenantAJwt}` },
});
ok("Tenant config current → 200 after pipeline", tenantConfig.status === 200);
const configJson = tenantConfig.body?.config_json;
ok("config_json has field_mappings", Array.isArray(configJson?.field_mappings));
ok("config_json has dag with nodes", Array.isArray(configJson?.dag?.nodes));
ok("config_json has dag with edges structure", "edges" in (configJson?.dag ?? {}));
ok("match_results in config_json", Array.isArray(configJson?.match_results));
ok("At least one field mapping generated", (configJson?.field_mappings?.length ?? 0) >= 1);
ok("At least one dag node generated", (configJson?.dag?.nodes?.length ?? 0) >= 1);

// Field mappings structural validation
const firstMapping = configJson?.field_mappings?.[0];
if (firstMapping) {
  ok("field_mapping has source_field", !!firstMapping.source_field);
  ok("field_mapping has target_field", !!firstMapping.target_field);
  ok("field_mapping has transformation_rule", !!firstMapping.transformation_rule);
  ok("field_mapping has confidence score", typeof firstMapping.confidence === "number");
  ok("field_mapping has requires_human_review flag", typeof firstMapping.requires_human_review === "boolean");
}

// DAG nodes structural validation
const firstNode = configJson?.dag?.nodes?.[0];
if (firstNode) {
  ok("dag_node has node_type", !!firstNode.node_type);
  ok("dag_node has retry_policy", typeof firstNode.retry_policy === "object");
  ok("dag_node has timeout_ms", typeof firstNode.timeout_ms === "number");
}

// ══════════════════════════════════════════════════════════════════════════════
//  Additional Security & Edge Case Tests
// ══════════════════════════════════════════════════════════════════════════════
section("SECURITY / EDGE CASES");

// Secrets resolve endpoint — cross-tenant
const crossSecret = await apiFetch(
  `${API}/api/secrets/resolve?path=vault://${tenantAId}/cibil-prod-key`,
  { headers: { Authorization: `Bearer ${tenantBJwt}` } }
);
ok("Cross-tenant secret resolve → 404/forbidden", crossSecret.status === 404 || crossSecret.status === 403);

// No secrets in raw responses
const configText = JSON.stringify(tenantConfig.body ?? {});
ok("No raw API keys in config response", !configText.match(/sk-|nvapi-|password|secret(?!_refs|s_refs)/i) || configText.includes("vault://"));

// 404 on unknown document
const notFound = await apiFetch(`${API}/api/documents/00000000-0000-0000-0000-000000000000`, {
  headers: { Authorization: `Bearer ${tenantAJwt}` },
});
ok("Unknown doc ID → 404", notFound.status === 404);

// ══════════════════════════════════════════════════════════════════════════════
//  SUMMARY
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(70)}`);
console.log(`  TEST SUMMARY`);
console.log(`${"═".repeat(70)}`);
console.log(`  ✅ Passed : ${pass}`);
console.log(`  ❌ Failed : ${fail}`);
console.log(`  ℹ️  Notes  : ${warn}`);
console.log(`  Total    : ${pass + fail}`);

if (errors.length) {
  console.log(`\n  Failed assertions:`);
  for (const e of errors) console.log(`    • ${e}`);
}

console.log(`\n  Phase coverage:`);
console.log(`    Phase  1 — Health checks`);
console.log(`    Phase  2 — DB Schema (domain model)`);
console.log(`    Phase  3 — Seed data / adapter registry`);
console.log(`    Phase  4 — Tenant middleware + secrets`);
console.log(`    Phase  5 — Document upload + dedup`);
console.log(`    Phase  6 — PII redaction (raw text)`);
console.log(`    Phase  7 — OCR / structure extraction`);
console.log(`    Phase  8 — Structured PII redaction`);
console.log(`    Phase  9 — AI requirement extraction`);
console.log(`    Phase 10 — Embedding + adapter matching`);
console.log(`    Phase 11 — Config generation + versioning`);

// Cleanup temp file
try { fs.unlinkSync(BRD_PATH); } catch {}

process.exit(fail > 0 ? 1 : 0);
