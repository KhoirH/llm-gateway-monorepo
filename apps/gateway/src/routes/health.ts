export async function healthRoutes(app: import("fastify").FastifyInstance) {
  app.get("/healthz", async () => {
    return { status: "ok" };
  });
}
