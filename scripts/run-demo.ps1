Set-Location (Join-Path $PSScriptRoot '..')

node scripts/reset-demo-db.mjs
npx ts-node scripts/seed-registry.ts
node scripts/bootstrap-demo-tenant.mjs

Write-Output 'READY FOR STELLARIS 2026. OPEN http://localhost:3000 TO START.'