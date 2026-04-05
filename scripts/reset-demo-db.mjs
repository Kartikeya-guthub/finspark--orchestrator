import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://finspark:finspark@127.0.0.1:5432/finspark',
});

const truncateOrder = [
  'audit_events',
  'approvals',
  'simulation_runs',
  'field_mappings',
  'dag_edges',
  'dag_nodes',
  'tenant_config_versions',
  'tenant_configs',
  'requirements',
  'adapter_versions',
  'adapters',
  'documents',
  'tenants',
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE TABLE ${truncateOrder.join(', ')} RESTART IDENTITY CASCADE`);
    await client.query('COMMIT');
    console.log('Database reset complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Database reset failed:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();