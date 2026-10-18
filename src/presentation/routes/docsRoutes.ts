import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiSpec } from "../../docs/openapi.js";

const router = Router();

router.get("/openapi.json", (_req, res) => {
  res.json(openApiSpec);
});

// swaggerUi.serve must be router-level middleware so the UI's asset requests
// (/docs/swagger-ui-*.js) are handled; router.get alone 404s them.
router.use(swaggerUi.serve);
router.get("/", swaggerUi.setup(openApiSpec, {
  customSiteTitle: "Usage Metering & Quota Service — API Docs",
  customCss: ".swagger-ui .topbar { display: none }",
}));

export default router;
