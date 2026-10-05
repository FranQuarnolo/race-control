import express, { Express } from "express";
import * as path from "path";
import { AppConfig, saveConfig } from "../config";
import { FormationStart } from "../instances/formationStart";
import { PenaltyEngine } from "../penalty/penaltyEngine";
import { PresenceWatchdog } from "../presence/presenceWatchdog";
import { StateTracker } from "../state/stateTracker";

export interface AdminApiDeps {
  config: AppConfig;
  stateTracker: StateTracker;
  formationStart: FormationStart;
  formationPenaltyEngine: PenaltyEngine;
  pitPenaltyEngine: PenaltyEngine;
  presenceWatchdog: PresenceWatchdog;
}

interface LightEvent {
  seq: number;
  type: "idle" | "formation" | "green";
}

export function createAdminApi(deps: AdminApiDeps): Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  let lightEventSeq = 0;
  let lastLightEvent: LightEvent = { seq: 0, type: "idle" };
  deps.formationStart.on("stateChanged", (type: LightEvent["type"]) => {
    lightEventSeq += 1;
    lastLightEvent = { seq: lightEventSeq, type };
  });

  app.get("/api/state", (_req, res) => {
    res.json({
      lightState: deps.formationStart.getLightState(),
      cars: deps.stateTracker.getConnected(),
      formationPenalties: deps.formationPenaltyEngine.getAll(),
      pitPenalties: deps.pitPenaltyEngine.getAll(),
    });
  });

  app.get("/api/config", (_req, res) => res.json(deps.config));

  app.post("/api/config", (req, res) => {
    Object.assign(deps.config, req.body);
    saveConfig(deps.config);
    res.json(deps.config);
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

  // Polling del cliente Python (Content Manager) — solo el evento global de semáforo.
  // Las sanciones individuales se avisan por chat del propio juego (sendChatToCar), que el
  // cliente también escucha, así no hace falta que la app sepa su propio carId.
  app.get("/api/client/poll", (_req, res) => {
    res.json({ lightEvent: lastLightEvent });
  });

  app.post("/api/client/heartbeat", (req, res) => {
    const steamGuid = String(req.body?.steamGuid ?? "");
    if (steamGuid) deps.presenceWatchdog.onHeartbeat(steamGuid);
    res.json({ ok: true });
  });

  return app;
}
