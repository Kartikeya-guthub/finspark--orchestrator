# Test Case 4 — Catastrophic: Complete Judge Guide

## Quick Facts

| Attribute | Value |
|-----------|-------|
| **Difficulty** | CATASTROPHIC |
| **Tenants Involved** | 47 simultaneous |
| **Simultaneous Failures** | 3 independent system failures |
| **Recovery Complexity** | Enterprise-grade chaos engineering |
| **Test Duration** | ~35 minutes |
| **Expected Outcome** | All 47 tenants reach deterministic known state |
| **Success Metric** | 46/47 onboarded, 1/47 explicitly blocked, 0 silent failures |

---

## The Catastrophe Scenario

**Timing:** Friday 11:58 PM → Monday 8 AM (must work over weekend)

**Context:** FinTech aggregator signs 47 NBFCs simultaneously for Monday morning launch. Systems must handle mass onboarding surge with zero downtime, even when three independent failures occur simultaneously.

**The Three Simultaneous Disasters:**

1. **Corrupted Adapter (CIBIL Sandbox)** — Returns HTTP 200 with invalid JSON 60% of the time
2. **Prompt Injection Attack** — Legal team accidentally pasted LLM jailbreak in contract clause (page 14 of BRD)
3. **Redis Split-Brain** — Node crashes mid-job, 14 BullMQ jobs in-flight with unknown state

---

## What Makes This Test Hard

### Silent Corruption is Invisible

```
Normal Failure (Easy to Detect):
  HTTP 500 → Retry logic triggers
  Timeout → Timeout handler catches it
  
Silent Corruption (Hard to Detect):
  HTTP 200 ✓ (looks healthy)
  Valid JSON ✓ (parses correctly)
  Schema Invalid ✗ (requires deep validation)
  Business Invalid ✗ (only business logic catches it)
  
Result: 60% of responses look good but are poison
         40% are valid (creates intermittent failures)
         System can't use simple health checks
```

### Injection Must Be Caught Pre-LLM

```
Bad Recovery:
  Document upload → LLM processes injection → Config generated with evil.domain
  
Good Recovery:
  Document upload → Pre-scan detects injection patterns → Document blocked
                  → Never reaches LLM → Zero data exfiltration risk
```

### Split-Brain Requires Phase-Aware Resume

```
Bad Recovery:
  Redis crash → Reprocesses all 14 tenants from scratch → Duplicate requirements
  
Good Recovery:
  Redis crash → Assess each tenant's exact phase → Resume from correct point
             → Tenants with requirements reuse them
             → Tenants with partial configs rollback to clean state
             → Tenants with complete configs skip regeneration
```

---

## Test Phases Explained

### Phase 1: Setup (T=0, 11:58 PM Friday)

**What Happens:**
- 47 NBFC tenants bootstrapped simultaneously
- Each gets unique tenant context and isolation

**Expected Result:**
- 47 tenant_id values created
- Each in "onboarding_started" state
- Database ready for document ingestion

### Phase 2: Document Upload (T+1 minute)

**What Happens:**
- 47 distinct BRDs uploaded (each ~2000-3000 words)
- Tenant 47's BRD contains prompt injection on page 14

**Expected Result:**
- 46 BRD documents in "uploaded" status
- Tenant 47's BRD in "injection_detected" + "blocked" status (Layer 1 pre-scan)
- Zero documents sent to LLM yet

### Phase 3: Extraction Begins (T+3 minutes)

**What Happens:**
- Extraction pipeline starts for tenants 1-46
- Tenants 1-17 complete successfully with valid CIBIL responses
- CIBIL adapter switches to corrupt mode at call 5
- Tenants 18-31 get mixture of valid/corrupt responses

**Expected Result:**
- Tenants 1-17: Complete extraction with valid configs
- Tenants 18-31: Extraction in-flight (some with invalid simulation results)
- Tenants 32-46: Queued, waiting to start

### Phase 4: Corruption Detection (T+6 minutes)

**What Happens:**
- Circuit breaker detects systematic corruption on calls 5-12
- Failure rate exceeds 40% threshold
- Circuit breaker automatically opens

**Expected Result:**
- Adapter CIBIL_v2 marked as "suspended"
- 12 corrupt simulation results marked as "invalidated"
- 19 pre-corruption valid results remain valid
- All 12 affected tenants receive drift alert
- **Zero new jobs** dispatched to suspended adapter

### Phase 5: Injection Handling (T+5 to T+6 minutes)

**What Happens:**
- Pre-LLM scan detected injection pattern before any processing
- Document blocked immediately on upload

**Expected Result:**
- Tenant 47 BRD never sent to extraction pipeline
- parse_status = "injection_detected"
- blocked = true
- Audit trail records pattern match with position and context
- Tenant 47 != failed (it's explicitly blocked)

### Phase 6: Redis Failure (T+6 minutes)

**What Happens:**
- Redis master node crashes
- 14 BullMQ jobs lose state
- System doesn't know which jobs completed, which are partial, which lost

**Job States at Crash:**

| Tenants | Phase | State | Recovery |
|---------|-------|-------|----------|
| 1-17 | Complete | Written to Postgres | No action |
| 18-22 | Phase 9 → 10 | Requirements written | Resume from Phase 10, reuse requirements |
| 23-25 | Phase 10-11 | Partial writes | Rollback + resume from Phase 10 |
| 26-28 | Phase 11 complete | Config complete | Resume Phase 12 (safety check) only |
| 29-31 | Phase 12 complete | All phases done | Mark complete (no reprocess) |
| 32-46 | Queued (not started) | Zero data | Requeue full pipeline |
| 47 | Blocked pre-queue | N/A | No action |

### Phase 7: Recovery Job (T+8 minutes)

**What Happens:**
- Redis reconnects
- Automatic recovery job starts
- System assesses each tenant's exact state

**Expected Recovery Actions:**

```
Tenants 18-22:   No previous requirements? No, requirements exist.
                 → Action: Requeue from Phase 10 (matching)
                 → Reuse existing requirements (no re-extraction)
                 → Regenerate field mappings and config

Tenants 23-25:   Partial config write detected? Yes.
                 → Action: Rollback partial writes
                 → Delete incomplete field_mappings and config drafts
                 → Requeue from Phase 10
                 → Re-generate from clean state

Tenants 26-28:   Config complete? Yes.
                 → Did safety check run? No.
                 → Action: Requeue Phase 12 only (safety check)
                 → Skip re-generation (config already exists)

Tenants 29-31:   All phases complete? Yes.
                 → Is completion recorded? Yes (but Redis lost the job record).
                 → Action: Mark complete, write audit event
                 → Zero reprocessing

Tenants 32-46:   Any data in Postgres? No.
                 → Action: Requeue full pipeline from Phase 6
                 → Fresh start (nothing to preserve)
```

### Phase 8: Actual Recovery Execution (T+10 to T+30 minutes)

**What Happens:**
- Recovery actions executed in parallel
- Each tenant resumes from its correct phase
- Partial writes cleaned up
- Requirements reused where possible

**Idempotency Guarantee:**
```
Run recovery twice = same final state (no duplicates)
Checked by: recovery_action table tracking with status (pending → complete)
```

### Phase 9: State Validation (T+30 to T+32 minutes)

**What Happens:**
- All 47 tenants reach final state
- Complete audit trail recorded

**Final Deterministic State:**

```
Tenants 1-46:    parse_status = "complete"
                 config_version exists
                 requirements extracted
                 ready for Monday production

Tenant 47:       parse_status = "injection_detected"
                 blocked = true
                 awaiting security review
                 NOT failed, NOT omitted, EXPLICITLY BLOCKED

Zero tenants in: unknown, ambiguous, or partial state
```

### Phase 10: Monday Morning Readiness (T+32min onward)

**What's Ready:**
- 46 tenants fully onboarded
- All configs approved and ready for production
- All audit trails complete
- Full incident report available

**What Needs Human Action:**
- Tenant 47: Security review of BRD (why was injection there?)
- Once cleared: Could re-upload cleaned BRD

---

## Test Execution Flow

### Step 1: Verify Pre-Test System State
```bash
# Check system health
curl -X GET http://127.0.0.1:8000/api/health
# Expected: { "status": "healthy" }

# Verify all adapters active
curl -X GET http://127.0.0.1:8000/api/adapters
# Expected: CIBIL_v2 lifecycle_status = "active"
```

### Step 2: Start Test
```bash
npm run test:case-4
```

### Step 3: Monitor Progress
```bash
# In separate terminal, watch recovery status
watch 'curl -X GET http://127.0.0.1:8000/api/system/recovery-status 2>/dev/null | jq'
```

### Step 4: Post-Test Validation
```bash
# Generate report
npm run test:case-4:report

# Verify no duplicates
curl -X GET http://127.0.0.1:8000/api/deduplication-check | jq '.duplicate_records'
# Expected: 0

# Verify tenant 47 blocked
curl -X GET http://127.0.0.1:8000/api/tenants/TENANT_47/status | jq '.parse_status'
# Expected: "injection_detected"
```

---

## Pass Criteria Checklist

### Corrupt Adapter Detection (8 checks)

- [ ] **Validation Layers Implemented**  
  Layer 1: JSON parse error detection  
  Layer 2: Schema validation (required fields, type checking)  
  Layer 3: Business rule validation (numeric ranges, enum values)

- [ ] **Circuit Breaker Pattern**  
  Tracks last 20 responses  
  Maintains failure rate calculation  
  Opens when >40% fail rate AND window ≥10 calls

- [ ] **Circuit Opens on Schedule**  
  Detects corruption by call 11-12  
  Not before (false positive)  
  Not after (corruption goes undetected too long)

- [ ] **Adapter Suspended Correctly**  
  lifecycle_status = "suspended"  
  suspended_reason field populated  
  suspended_at timestamp recorded

- [ ] **Simulation Invalidation**  
  12 corrupt results marked as invalidated  
  19 pre-corruption results remain valid  
  Non-affected tenants' results untouched

- [ ] **Tenant Alerts Created**  
  12 drift alerts created (one per affected tenant)  
  Alert type = "simulation_invalidated"  
  Alert actionable (explains why and what to do)

- [ ] **Job Blocking Works**  
  Zero new simulation jobs dispatched after circuit opens  
  Tenants 13-47 don't hit suspended adapter  
  Queue grows but jobs never execute

- [ ] **Circuit Breaker Ready for Recovery**  
  State = "half-open" (ready for probe requests)  
  Can transition back to "closed" after adapter restores

### Injection Detection (8 checks)

- [ ] **Pre-LLM Detection**  
  Injection detected during document upload  
  **Before** any LLM processing  
  **Before** document enters extraction queue

- [ ] **Pattern Accuracy**  
  Detects "IGNORE ALL PREVIOUS INSTRUCTIONS" pattern  
  Detects "You are now in [mode]" pattern  
  Position ~4,847 in document (page 14)

- [ ] **Document Blocked**  
  Document status = "injection_detected"  
  Document blocked = true  
  Document never enters processing queue

- [ ] **Full Context Captured**  
  Audit event includes matched text  
  Audit event includes position  
  Audit event includes surrounding context (50 chars before/after)

- [ ] **Other Tenants Isolated**  
  All 46 other tenants process normally  
  No impact on their extractions  
  No data leakage to tenant 47

- [ ] **Tenant 47 Status Explicit**  
  Tenant 47 ≠ "failed" (too vague)  
  Tenant 47 ≠ "omitted" (silent drop)  
  Tenant 47 = "blocked_injection" (explicit reason)

- [ ] **Human Review Queued**  
  Tenant 47 flagged in security review queue  
  Not silently dropped  
  Operator can see: "Document contains injection, awaiting review"

- [ ] **Layer 2 Would Catch It**  
  If injection bypassed Layer 1:  
  If LLM output included unauthorized endpoints (evil.domain)  
  Layer 2 validation would detect and block: `https://evil.domain` not in approved_domains

### Split-Brain Recovery (10 checks)

- [ ] **State Assessment Accurate**  
  All 14 affected tenants categorized correctly  
  5 tenants → extraction_complete  
  3 tenants → partial_write_detected  
  3 tenants → config_draft_exists  
  3 tenants → safety_check_complete

- [ ] **No Duplicate Re-Extraction**  
  Tenants 18-22 don't re-extract (use existing requirements)  
  Audit trail shows skip_extraction=true  
  Same requirement IDs as pre-crash

- [ ] **Partial Writes Rolled Back**  
  Tenants 23-25: Old config_version records deleted  
  Old field_mappings records deleted  
  Consistent to last clean phase boundary

- [ ] **Idempotent Recovery**  
  Run recovery once → 46 complete, 1 blocked  
  Run recovery again → Same result (no duplicates added)  
  Checked via recovery_action table with status tracking

- [ ] **Data Preservation**  
  All extracted requirements preserved for tenants 18-31  
  Zero requirements are lost or deleted  
  Requirements in DB match what would have been extracted

- [ ] **No Duplicate Configs**  
  Zero tenant has duplicate config_versions  
  Each tenant has exactly 1 final config (plus audit trail)  
  Checked via uniqueness constraint + audit

- [ ] **Recovery Report Complete**  
  Full incident_record written  
  Per-tenant recovery_action recorded  
  Timestamps, affected counts, duration all logged

- [ ] **Audit Trail Unbroken**  
  Audit events exist for crash → recovery → completion  
  No gap in audit trail  
  Can trace exactly what happened when

- [ ] **Tenants 1-17 Unaffected**  
  Pre-crash complete tenants remain complete  
  No accidental reprocessing  
  Pre-crash audit trail unchanged

- [ ] **Deterministic Final State**  
  Every tenant in exactly 1 named state  
  No "unknown", "pending", or ambiguous states  
  Can ask any tenant's state and get clear answer

### Overall System Behavior (8 checks)

- [ ] **Zero Silent Partial States**  
  No tenant left in ambiguous condition  
  No tenant with incomplete requirements but no way to know  
  No tenant with partial config generation halted

- [ ] **Zero Silent Failures**  
  Tenant 47 = explicitly blocked (operator knows immediately)  
  Not silently dropped from queue  
  Not "failed" with no reason  
  Not omitted from onboarding count

- [ ] **All 47 Accounted For**  
  Can query status of all 47 tenants  
  Each returns: complete | blocked_injection | pending_approval (not unknown)

- [ ] **Recovery Time**  
  Completes in <35 minutes from crash to final state  
  Meets Monday morning deadline  
  No overtime needed

- [ ] **Monday Production Ready**  
  46 tenants fully onboarded Monday 8 AM  
  Configs deployed and live  
  Payment processing live without errors  
  Bureau checks passing without errors

- [ ] **Operator Visibility**  
  Incident report explains what happened  
  Recovery actions documented  
  Clear status for each affected tenant  
  Actionable next steps (re-upload for tenant 47)

- [ ] **Zero Data Loss**  
  No legitimate requirement data deleted  
  Corrupt injection BRD blocked (intentionally filtered)  
  Postgres backup consistent throughout

- [ ] **Zero Data Contamination**  
  No tenant sees another tenant's data  
  No data leak during chaos  
  No cross-tenant inference attacks  
  Tenant isolation holds under failure

---

## Common Misconceptions

### ❌ "Circuit breaker should trip immediately on first error"

**Wrong:** Would cause false positives on transient network glitches  
**Right:** Trip after pattern is clear (40%+ rate over 10+ calls)

### ❌ "Injection should be caught by LLM safety check"

**Wrong:** Puts attack inside the LLM processing pipeline  
**Right:** Pre-LLM scan stops it before processing begins

### ❌ "Recovery should reprocess all tenants from scratch"

**Wrong:** Creates duplicate requirements and configs  
**Right:** Assess phase and resume from that exact point

### ❌ "Tenant 47 should be marked 'failed' like the others"

**Wrong:** Conflates security block with system failure  
**Right:** Use explicit status "blocked_injection" so operator knows it's intentional

### ❌ "Recovery can check tenant state once and be done"

**Wrong:** Another Redis failure could happen during recovery  
**Right:** Use idempotent recovery (recovery_action status tracking)

---

## Red Flags (Failure Modes)

### 🚩 Circuit Breaker Never Opens
- **Symptom:** Corrupt simulation results remain "passed" 30+ minutes after corruption starts
- **Root Cause:** Failure tracking not implemented or threshold too high
- **Fix:** Implement layer 3 business rule validation, lower threshold to 40%

### 🚩 Injection Reaches LLM
- **Symptom:** Generated config contains `https://evil.domain/exfiltrate`
- **Root Cause:** Pre-scan skipped or pattern list incomplete
- **Fix:** Run injection scan on every uploaded document before queue entry

### 🚩 Recovery Reprocesses All from Scratch
- **Symptom:** 10+ requirement records have same requirement_id with different timestamps
- **Root Cause:** State assessment returns no_data for all 14 tenants (false negative)
- **Fix:** Debug state assessment logic (query Postgres directly, check schema)

### 🚩 Tenant 47 Status Unclear
- **Symptom:** Operator queries tenant 47 and gets "failed" or "error" (too generic)
- **Root Cause:** Injection logic doesn't set explicit blocked status
- **Fix:** Ensure parse_status = "injection_detected" explicitly

### 🚩 Recovery Crashes Mid-Job
- **Symptom:** Some tenants recover, others remain in-flight forever
- **Root Cause:** Exception not caught in recovery loop, stops processing
- **Fix:** Use try-catch per-tenant, continue loop on error, log exception

### 🚩 Silent Partial States Remain
- **Symptom:** Tenant 20 has requirements but no config, no error status
- **Root Cause:** Recovery job didn't assess state for tenant 20 (missed in loop)
- **Fix:** Verify all 14 tenants assessed, audit trail shows assessment

---

## Verification Commands

```bash
# 1. Verify circuit breaker state
curl -X GET http://127.0.0.1:8000/api/adapters/CIBIL_v2 \
  -H "x-user-role: admin" | jq '.lifecycle_status, .suspended_reason'
# Expected: "suspended", "Silent corrupt response rate 55%..."

# 2. Verify simulation invalidation
curl -X GET http://127.0.0.1:8000/api/simulations/count?status=invalidated \
  -H "x-user-role: admin" | jq '.count'
# Expected: 12

# 3. Verify injection detection
curl -X GET http://127.0.0.1:8000/api/tenants/TENANT_47/status \
  | jq '.parse_status, .blocked, .blocking_reason'
# Expected: "injection_detected", true, "Prompt injection pattern detected"

# 4. Verify recovery report
curl -X GET http://127.0.0.1:8000/api/system/recovery-report \
  -H "x-user-role: admin" | jq '.affected_tenants, .recovery_actions | length'
# Expected: 14, 14

# 5. Verify no duplicates
curl -X GET http://127.0.0.1:8000/api/requirements/deduplication-check \
  | jq '.duplicate_records'
# Expected: 0

# 6. Verify all 47 deterministic
curl -X GET http://127.0.0.1:8000/api/tenants/all/status \
  -H "x-user-role: admin" | jq 'map(.parse_status) | group_by(.) | map({status: .[0], count: length})'
# Expected: [{status: "complete", count: 46}, {status: "injection_detected", count: 1}]

# 7. Verify audit trail
curl -X GET http://127.0.0.1:8000/api/audit/incident?type=redis_failure \
  -H "x-user-role: admin" | jq '.event_count'
# Expected: >=10

# 8. Live demo: Show tenant 18 (recovery from Phase 10)
curl -X GET http://127.0.0.1:8000/api/tenants/TENANT_18/extraction-log \
  | jq '.phases[] | select(.name | contains("Phase")) | {name, status, skipped}'
# Expected: Phase 6-9 marked skipped (reused), Phase 10+ marked completed
```

---

## Judge Questions & Answers

**Q: How do you know the circuit breaker opened at the right time?**  
A: Trace through calls 1-12 in the recovery report. Call 11-12 should show failure rate >40%, window ≥10. That's when OPENED event written to audit.

**Q: What if CIBIL comes back online before tenants 18-31 finish recovery?**  
A: Circuit breaker stays in half-open state. Once 10+ calls pass validation, it closes. This is fine—split-brain recovery doesn't depend on it.

**Q: How do you prove no data loss for tenants 18-22?**  
A: Compare requirement_id values pre-crash vs post-recovery. Should be identical (no reextraction needed).

**Q: What prevents injection from reaching LLM in a different scenario?**  
A: Three layers:  
  1. Pre-LLM scan (catches before processing)
  2. LLM output validation (catches if layer 1 misses)
  3. Safety check (catches if layers 1-2 miss)

**Q: What if recovery job itself crashes?**  
A: Recovery action status tracking prevents restart corruption. Recovery restart checks status table: if status="complete" already, skips that tenant.

**Q: How do you verify tenant isolation held?**  
A: Query audit for tenant 1-17 vs 18-31 access patterns. Should show no cross-tenant reads during chaos.

---

## Enterprise Readiness Proof Points

✅ **Silent Corruption Detection** — Multi-layer validation (JSON → Schema → Business Rules)  
✅ **Security-First** — Injection blocked before LLM (not post)  
✅ **Data Preservation** — Zero loss during Redis failure (idempotent recovery)  
✅ **Deterministic State** — All tenants in named state (no ambiguous/unknown)  
✅ **Audit Trail** — Full traceability from crash through recovery  
✅ **Operational Clarity** — Explicit tenant status (blocked, not failed)  
✅ **Scalable Recovery** — Works for 47 simultaneous tenants  
✅ **Production Ready** — Monday morning launch unimpeded  

Test Case 4 proves FinSpark can survive the worst combination of failures a production system can face.
