import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    tenant?: {
      id: string;
      authType: "jwt" | "api_key";
    };
  }
}
