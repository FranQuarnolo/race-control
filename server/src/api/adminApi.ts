import express, { Express } from "express";
import * as path from "path";
import { AppConfig, applyConfigPatch } from "../config";
import { FormationStart } from "../instances/formationStart";
import { PenaltyEngine } from "../penalty/penaltyEngine";
import { PresenceWatchdog } from "../presence/presenceWatchdog";
import { StateTracker } from "../state/stateTracker";
import { ConnectivityManager } from "../net/connectivity";

export interface AdminApiDeps {
  config: AppConfig;
  firstRun: boolean;
  stateTracker: StateTracker;
  formationStart: FormationStart;
  formationPenaltyEngine: PenaltyEngine;
  pitPenaltyEngine: PenaltyEngine;
  presenceWatchdog: PresenceWatchdog;
  connectivity: ConnectivityManager;
  buildEmperorServersSnippet: () => string;
}

const TELEMETRY_STALE_MS = 2000;

/**
 * Panel y API de administración — se levanta SIEMPRE en 127.0.0.1 (ver index.ts), nunca expuesto
 * a internet. Los endpoints que sí necesitan ser alcanzables desde afuera (cliente Python) viven
 * en clientApi.ts, en un puerto/listener separado.
 */
export function createAdminApi(deps: AdminApiDeps): Express {
  const app = express();
  app.use(express.json({ limit: "50kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/state", (_req, res) => {
    deps.connectivity.refreshTelemetryFlag();
    const now = Date.now();
    res.json({
      firstRun: deps.firstRun,
      leagueName: deps.config.leagueName,
      shadowMode: deps.config.shadowMode,
      lightState: deps.formationStart.getLightState(),
      cars: deps.stateTracker.getConnected().map((car) => ({
        ...car,
        telemetryStale: car.lastUpdate === 0 || now - car.lastUpdate > TELEMETRY_STALE_MS,
      })),
      formationPenalties: deps.formationPenaltyEngine.getAll(),
      pitPenalties: deps.pitPenaltyEngine.getAll(),
      network: {
        ...deps.connectivity.getStatus(),
        emperorServersSnippet: deps.buildEmperorServersSnippet(),
      },
    });
  });

  app.get("/api/config", (_req, res) => res.json(deps.config));

  app.post("/api/config", (req, res) => {
    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
      res.status(400).json({ ok: false, error: "Body inválido" });
      return;
    }
    try {
      applyConfigPatch(deps.config, req.body);
      res.json(deps.config);
    } catch (err) {
      // No dejar que un error de escritura (ej. permisos) tumbe el request en silencio — el
      // panel necesita un JSON para poder avisarle al usuario que algo falló.
      console.error("[admin-api] No se pudo guardar la configuración:", err);
      res.status(500).json({ ok: false, error: "No se pudo guardar la configuración: " + String(err) });
    }
  });

  app.post("/api/formation/begin", (_req, res) => {
    deps.formationStart.beginFormation();
    res.json({ ok: true, lightState: deps.formationStart.getLightState() });
  });

  app.post("/api/formation/green", (_req, res) => {
    deps.formationStart.triggerGreen();
    res.json({ ok: true, lightState: deps.formationStart.getLightState() });
  });

  app.post("/api/formation/reset", (_req, res) => {
    deps.formationStart.reset();
    res.json({ ok: true, lightState: deps.formationStart.getLightState() });
  });

  // Red de seguridad: cualquier excepción no prevista en una ruta devuelve JSON, no la página de
  // error HTML por defecto de Express — el panel siempre espera poder parsear la respuesta.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[admin-api] Error no manejado:", err);
    res.status(500).json({ ok: false, error: String(err) });
  });

  return app;
}
