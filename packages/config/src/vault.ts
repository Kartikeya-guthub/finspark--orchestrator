export interface VaultProvider {
  getSecret(path: string): Promise<string>;
}

export class EnvVaultProvider implements VaultProvider {
  async getSecret(path: string): Promise<string> {
    const value = process.env[path];
    if (!value) {
      throw new Error(`Secret not found for key: ${path}`);
    }
    return value;
  }
}
