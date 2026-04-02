INSERT INTO tenants (id, name, status)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'Demo Lending Co', 'active'),
  ('22222222-2222-2222-2222-222222222222', 'Demo Payments Ltd', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO documents (id, tenant_id, filename, storage_path, fingerprint, parse_status)
VALUES
  ('aaaa1111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'brd-lending-v1.txt', '/demo/brd-lending-v1.txt', 'fp-brd-lending-v1', 'parsed'),
  ('bbbb2222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'brd-risk-v1.txt', '/demo/brd-risk-v1.txt', 'fp-brd-risk-v1', 'parsed'),
  ('cccc3333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'brd-payments-v1.txt', '/demo/brd-payments-v1.txt', 'fp-brd-payments-v1', 'parsed')
ON CONFLICT (id) DO NOTHING;

INSERT INTO requirements (id, document_id, tenant_id, service_type, mandatory, confidence, source_sentence, status)
VALUES
  ('ddddeeee-0001-0000-0000-000000000001', 'aaaa1111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'bureau_pull', true, 0.9400, 'All personal loan applications above INR 50,000 must include bureau pull from at least one approved bureau adapter.', 'active'),
  ('ddddeeee-0002-0000-0000-000000000002', 'bbbb2222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'fraud_screening', true, 0.9100, 'Fraud screening must execute before final underwriting decision for every new-to-credit customer.', 'active'),
  ('ddddeeee-0003-0000-0000-000000000003', 'cccc3333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'payment_collection', false, 0.8800, 'Payment retries should follow exponential backoff and route to a secondary gateway on primary failure.', 'active')
ON CONFLICT (id) DO NOTHING;

WITH adapter_rows(name, category, provider, description, capability_tags, auth_type) AS (
  VALUES
    ('CIBIL', 'bureau', 'TransUnion CIBIL', 'Credit bureau score and report pull API.', ARRAY['bureau', 'score', 'report']::TEXT[], 'api_key'),
    ('Experian', 'bureau', 'Experian India', 'Consumer and commercial bureau APIs.', ARRAY['bureau', 'score', 'tradeline']::TEXT[], 'oauth2_client_credentials'),
    ('Equifax', 'bureau', 'Equifax', 'Credit risk and score APIs.', ARRAY['bureau', 'risk', 'score']::TEXT[], 'api_key'),
    ('CRIF High Mark', 'bureau', 'CRIF High Mark', 'Credit bureau services for retail and MSME underwriting.', ARRAY['bureau', 'msme', 'score']::TEXT[], 'api_key'),
    ('Aadhaar eKYC', 'kyc', 'UIDAI Partner Network', 'Identity verification via Aadhaar eKYC.', ARRAY['kyc', 'identity', 'otp']::TEXT[], 'oauth2_client_credentials'),
    ('PAN Verification', 'kyc', 'NSDL', 'PAN status and identity verification.', ARRAY['kyc', 'pan', 'identity']::TEXT[], 'api_key'),
    ('Video KYC', 'kyc', 'RegTech Video Services', 'Agent-assisted video KYC flow.', ARRAY['kyc', 'video', 'face_match']::TEXT[], 'jwt'),
    ('Signzy KYC', 'kyc', 'Signzy', 'Unified identity verification and compliance workflows.', ARRAY['kyc', 'compliance', 'identity']::TEXT[], 'api_key'),
    ('GST Verification', 'gst', 'GSTN', 'Validate GST registration profile.', ARRAY['gst', 'verification', 'tax']::TEXT[], 'api_key'),
    ('GSTR Fetch', 'gst', 'GSTN', 'Fetch GSTR filings and summaries.', ARRAY['gst', 'gstr', 'tax_return']::TEXT[], 'api_key'),
    ('Razorpay', 'payment', 'Razorpay', 'Payment gateway collections and payouts.', ARRAY['payment', 'upi', 'card']::TEXT[], 'api_key_secret'),
    ('Stripe', 'payment', 'Stripe', 'Global card and bank payments.', ARRAY['payment', 'card', 'webhook']::TEXT[], 'api_key'),
    ('FraudShield', 'fraud', 'FraudShield Labs', 'Real-time fraud signals and scoring.', ARRAY['fraud', 'score', 'device_fingerprint']::TEXT[], 'api_key'),
    ('ThreatMetrix', 'fraud', 'LexisNexis', 'Digital identity network fraud intelligence.', ARRAY['fraud', 'device', 'behavioral']::TEXT[], 'oauth2_client_credentials'),
    ('Account Aggregator AA', 'open_banking', 'AA Network', 'Consent-based account data aggregation.', ARRAY['open_banking', 'consent', 'aggregation']::TEXT[], 'mutual_tls')
), upserted AS (
  INSERT INTO adapters (name, category, provider, description, capability_tags, auth_type)
  SELECT name, category, provider, description, capability_tags, auth_type
  FROM adapter_rows
  ON CONFLICT (name, provider) DO UPDATE
  SET
    category = EXCLUDED.category,
    description = EXCLUDED.description,
    capability_tags = EXCLUDED.capability_tags,
    auth_type = EXCLUDED.auth_type
  RETURNING id, name, provider
)
SELECT 1;

WITH v(name, provider, api_version, schema_def, lifecycle_status, mock_endpoint) AS (
  VALUES
    ('CIBIL', 'TransUnion CIBIL', 'v2.1', '{"request_schema":{"fields":["pan","consent_id"]},"response_schema":{"fields":["score","report_summary"]},"required_auth_fields":["x_api_key"],"capability_tags":["bureau","score","report"]}'::jsonb, 'active', '/mock/bureau/cibil/v2.1'),
    ('CIBIL', 'TransUnion CIBIL', 'v3.0', '{"request_schema":{"fields":["pan","aadhaar_hash","consent_id"]},"response_schema":{"fields":["score","tradelines","report_pdf_url"]},"required_auth_fields":["x_api_key","x_client_id"],"capability_tags":["bureau","score","tradeline"]}'::jsonb, 'active', '/mock/bureau/cibil/v3.0'),
    ('Experian', 'Experian India', 'v1.5', '{"request_schema":{"fields":["pan","mobile"]},"response_schema":{"fields":["score","risk_band"]},"required_auth_fields":["client_id","client_secret"],"capability_tags":["bureau","risk"]}'::jsonb, 'deprecated', '/mock/bureau/experian/v1.5'),
    ('Experian', 'Experian India', 'v2.0', '{"request_schema":{"fields":["pan","mobile","consent_id"]},"response_schema":{"fields":["score","risk_band","inquiry_history"]},"required_auth_fields":["client_id","client_secret","scope"],"capability_tags":["bureau","risk","history"]}'::jsonb, 'active', '/mock/bureau/experian/v2.0'),
    ('Equifax', 'Equifax', 'v1.0', '{"request_schema":{"fields":["pan","dob"]},"response_schema":{"fields":["score","alerts"]},"required_auth_fields":["x_api_key"],"capability_tags":["bureau","alerts"]}'::jsonb, 'active', '/mock/bureau/equifax/v1.0'),
    ('CRIF High Mark', 'CRIF High Mark', 'v1.0', '{"request_schema":{"fields":["pan","mobile","consent_id"]},"response_schema":{"fields":["score","segment","enquiry_summary"]},"required_auth_fields":["x_api_key","x_partner_code"],"capability_tags":["bureau","msme","score"]}'::jsonb, 'active', '/mock/bureau/crif/v1.0'),
    ('Aadhaar eKYC', 'UIDAI Partner Network', 'v1.0', '{"request_schema":{"fields":["aadhaar","otp"]},"response_schema":{"fields":["name","dob","address"]},"required_auth_fields":["client_id","client_secret"],"capability_tags":["kyc","identity"]}'::jsonb, 'deprecated', '/mock/kyc/aadhaar/v1.0'),
    ('Aadhaar eKYC', 'UIDAI Partner Network', 'v2.0', '{"request_schema":{"fields":["aadhaar_ref","otp","consent_token"]},"response_schema":{"fields":["name","dob","address","photo_hash"]},"required_auth_fields":["client_id","client_secret","scope"],"capability_tags":["kyc","identity","consent"]}'::jsonb, 'active', '/mock/kyc/aadhaar/v2.0'),
    ('PAN Verification', 'NSDL', 'v1.2', '{"request_schema":{"fields":["pan","name"]},"response_schema":{"fields":["pan_status","name_match"]},"required_auth_fields":["x_api_key"],"capability_tags":["kyc","pan"]}'::jsonb, 'active', '/mock/kyc/pan/v1.2'),
    ('Video KYC', 'RegTech Video Services', 'v1.0', '{"request_schema":{"fields":["session_id","agent_id"]},"response_schema":{"fields":["kyc_status","face_match_score"]},"required_auth_fields":["jwt_token"],"capability_tags":["kyc","video"]}'::jsonb, 'active', '/mock/kyc/video/v1.0'),
    ('Signzy KYC', 'Signzy', 'v1.0', '{"request_schema":{"fields":["pan","aadhaar_ref","consent_id"]},"response_schema":{"fields":["identity_status","risk_flags"]},"required_auth_fields":["x_api_key","x_workspace_id"],"capability_tags":["kyc","compliance","identity"]}'::jsonb, 'active', '/mock/kyc/signzy/v1.0'),
    ('GST Verification', 'GSTN', 'v1.0', '{"request_schema":{"fields":["gstin"]},"response_schema":{"fields":["legal_name","registration_status"]},"required_auth_fields":["x_api_key"],"capability_tags":["gst","verification"]}'::jsonb, 'deprecated', '/mock/gst/verification/v1.0'),
    ('GST Verification', 'GSTN', 'v2.0', '{"request_schema":{"fields":["gstin","consent_id"]},"response_schema":{"fields":["legal_name","registration_status","filing_status"]},"required_auth_fields":["x_api_key","x_partner_id"],"capability_tags":["gst","verification","filing"]}'::jsonb, 'active', '/mock/gst/verification/v2.0'),
    ('GSTR Fetch', 'GSTN', 'v1.0', '{"request_schema":{"fields":["gstin","period"]},"response_schema":{"fields":["gstr1","gstr3b"]},"required_auth_fields":["x_api_key"],"capability_tags":["gst","gstr"]}'::jsonb, 'active', '/mock/gst/gstr/v1.0'),
    ('Razorpay', 'Razorpay', 'v1.0', '{"request_schema":{"fields":["amount","currency","method"]},"response_schema":{"fields":["payment_id","status"]},"required_auth_fields":["key_id","key_secret"],"capability_tags":["payment","upi","card"]}'::jsonb, 'active', '/mock/payment/razorpay/v1.0'),
    ('Stripe', 'Stripe', 'v2022-11-15', '{"request_schema":{"fields":["amount","currency","payment_method_types"]},"response_schema":{"fields":["payment_intent_id","status"]},"required_auth_fields":["bearer_token"],"capability_tags":["payment","card","webhook"]}'::jsonb, 'active', '/mock/payment/stripe/v2022-11-15'),
    ('FraudShield', 'FraudShield Labs', 'v1.0', '{"request_schema":{"fields":["customer_id","ip","device_id"]},"response_schema":{"fields":["risk_score","risk_level"]},"required_auth_fields":["x_api_key"],"capability_tags":["fraud","score"]}'::jsonb, 'deprecated', '/mock/fraud/fraudshield/v1.0'),
    ('FraudShield', 'FraudShield Labs', 'v2.0', '{"request_schema":{"fields":["customer_id","ip","device_id","geo"]},"response_schema":{"fields":["risk_score","risk_level","signals"]},"required_auth_fields":["x_api_key","x_org_id"],"capability_tags":["fraud","score","signals"]}'::jsonb, 'active', '/mock/fraud/fraudshield/v2.0'),
    ('ThreatMetrix', 'LexisNexis', 'v3.1', '{"request_schema":{"fields":["session_id","user_id"]},"response_schema":{"fields":["policy_score","recommendation"]},"required_auth_fields":["client_id","client_secret"],"capability_tags":["fraud","behavioral"]}'::jsonb, 'active', '/mock/fraud/threatmetrix/v3.1'),
    ('Account Aggregator AA', 'AA Network', 'v1.0', '{"request_schema":{"fields":["consent_handle","customer_ref"]},"response_schema":{"fields":["consent_status","accounts"]},"required_auth_fields":["mtls_cert","mtls_key"],"capability_tags":["open_banking","consent"]}'::jsonb, 'deprecated', '/mock/open-banking/aa/v1.0'),
    ('Account Aggregator AA', 'AA Network', 'v2.0', '{"request_schema":{"fields":["consent_handle","customer_ref","purpose_code"]},"response_schema":{"fields":["consent_status","accounts","fi_data"]},"required_auth_fields":["mtls_cert","mtls_key","x_fiu_id"],"capability_tags":["open_banking","consent","aggregation"]}'::jsonb, 'active', '/mock/open-banking/aa/v2.0')
)
INSERT INTO adapter_versions (adapter_id, api_version, schema_def, lifecycle_status, mock_endpoint)
SELECT a.id, v.api_version, v.schema_def, v.lifecycle_status, v.mock_endpoint
FROM v
JOIN adapters a ON a.name = v.name AND a.provider = v.provider
ON CONFLICT (adapter_id, api_version) DO UPDATE
SET
  schema_def = EXCLUDED.schema_def,
  lifecycle_status = EXCLUDED.lifecycle_status,
  mock_endpoint = EXCLUDED.mock_endpoint;
