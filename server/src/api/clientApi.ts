import express, { Express } from "express";
import { PresenceWatchdog } from "../presence/presenceWatchdog";
import { LightEventTracker } from "../instances/lightEventTracker";

export interface ClientApiDeps {
  lightEventTracker: LightEventTracker;
  presenceWatchdog: PresenceWatchdog;
  /** Avisa al announcer que este piloto ya recibió la dirección del backend — corta los reintentos. */
  onHeartbeat: (driverGuid: string) => void;
}

// SteamID64: 17 dígitos numéricos. El rango exacto queda a confirmar contra el spike de protocolo
// (ver docs/spike-protocolo.md) — mientras tanto se acepta un rango razonable para no bloquear
// heartbeats legítimos si el formato real difiere levemente.
const STEAM_GUID_PATTERN = /^[0-9]{15,20}$/;

/**
 * Endpoints que consume el cliente Python de Content Manager — separados del panel admin a
 * propósito: este puerto es el que se expone/forwardea a internet, el del panel NUNCA.
 */
export function createClientApi(deps: ClientApiDeps): Express {
  const app = express();
  app.use(express.json({ limit: "10kb" }));

  app.get("/api/client/poll", (_req, res) => {
    res.json({ lightEvent: deps.lightEventTracker.get() });
  });

  app.post("/api/client/heartbeat", (req, res) => {
    const steamGuid = String(req.body?.steamGuid ?? "");
    if (STEAM_GUID_PATTERN.test(steamGuid)) {
      deps.presenceWatchdog.onHeartbeat(steamGuid);
      deps.onHeartbeat(steamGuid);
    }
    res.json({ ok: true });
  });

  return app;
}
