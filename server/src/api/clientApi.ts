import express, { Express } from "express";
import { PresenceWatchdog } from "../presence/presenceWatchdog";
import { LightEventTracker } from "../instances/lightEventTracker";
import { DriverTelemetryStore } from "../telemetry/driverTelemetry";

export interface ClientApiDeps {
  lightEventTracker: LightEventTracker;
  presenceWatchdog: PresenceWatchdog;
  telemetryStore: DriverTelemetryStore;
  /** Salidas de pista ya cerradas que el cliente venía acumulando. Llegan por lote, no como
   * stream: el cliente detecta la transición y la encola hasta el próximo heartbeat. */
  onExcursions: (driverGuid: string, excursions: unknown) => void;
  /** Avisa al announcer que este piloto ya recibió la dirección del backend — corta los reintentos. */
  onHeartbeat: (driverGuid: string) => void;
  /** Grip de la pista leído de la Shared Memory. Es una condición del circuito, no del piloto. */
  onSurfaceGrip: (grip: number) => void;
}

// SteamID64: 17 dígitos numéricos. El rango exacto queda a confirmar contra el spike de protocolo
// (ver docs/spike-protocolo.md) — mientras tanto se acepta un rango razonable para no bloquear
// heartbeats legítimos si el formato real difiere levemente.
const STEAM_GUID_PATTERN = /^[0-9]{15,20}$/;

/** El ping lo calcula el cliente, que corre en la PC del piloto y es un `.py` editable. Un valor
 * absurdo (negativo, infinito, 9 horas) se descarta en vez de mostrarse en el panel: es un dato
 * informativo, no vale la pena confiar en él sin filtrar. El tope es el timeout del propio
 * cliente (2 s) con margen. */
function plausiblePing(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5000) return undefined;
  return Math.round(value);
}

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

  /**
   * Presencia + telemetría fina en la misma request.
   *
   * Un solo canal y no dos: mismo `driverGuid`, misma validación, mismo modo de fallo. Partirlo en
   * un endpoint aparte duplicaría todo eso para ganar nada — el cliente ya tiene que mandar este
   * POST igual para no ser kickeado por el watchdog.
   */
  app.post("/api/client/heartbeat", (req, res) => {
    const steamGuid = String(req.body?.steamGuid ?? "");
    if (STEAM_GUID_PATTERN.test(steamGuid)) {
      deps.presenceWatchdog.onHeartbeat(steamGuid, plausiblePing(req.body?.pingMs));
      deps.onHeartbeat(steamGuid);
      // `telemetry` es opcional: un cliente viejo (o uno al que le falló la lectura de Shared
      // Memory) sigue siendo un heartbeat válido. La torre de tiempos muestra guiones y listo.
      if (req.body?.telemetry !== undefined) {
        deps.telemetryStore.report(steamGuid, req.body.telemetry);
        // El grip es de la pista, no del piloto: viaja por acá porque es el único canal que lo ve,
        // pero se guarda una sola vez para toda la sesión en vez de por fila de la torre.
        const grip = (req.body.telemetry as Record<string, unknown> | null)?.surfaceGrip;
        if (typeof grip === "number") deps.onSurfaceGrip(grip);
      }
      if (req.body?.excursions !== undefined) deps.onExcursions(steamGuid, req.body.excursions);
    }
    res.json({ ok: true });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[client-api] Error no manejado:", err);
    res.status(500).json({ ok: false });
  });

  return app;
}
