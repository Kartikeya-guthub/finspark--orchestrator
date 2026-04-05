import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://finspark:finspark@127.0.0.1:5432/finspark',
});

async function main() {
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id FROM tenants WHERE name = $1 LIMIT 1', ['DemoBank']);
    if (existing.rowCount && existing.rows[0]) {
      console.log(`DemoBank tenant already exists: ${existing.rows[0].id}`);
      return;
    }

    const created = await client.query('INSERT INTO tenants (name, status) VALUES ($1, $2) RETURNING id', ['DemoBank', 'active']);
    console.log(`DemoBank tenant created: ${created.rows[0].id}`);
  } catch (error) {
    console.error('Tenant bootstrap failed:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();