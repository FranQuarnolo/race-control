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
  /** Devuelve el `steamGuid` que acredita el token, o `null`. Ver security/pilotToken.ts. */
  verifyToken: (token: string | undefined) => string | null;
}

// SteamID64: 17 dígitos numéricos. El rango exacto queda a confirmar contra el spike de protocolo
// (ver docs/spike-protocolo.md) — mientras tanto se acepta un rango razonable para no bloquear
// heartbeats legítimos si el formato real difiere levemente.
const STEAM_GUID_PATTERN = /^[0-9]{15,20}$/;

/** El guid que el token acredita, puesto por el middleware de autenticación. */
interface AuthedRequest extends express.Request {
  pilotGuid?: string;
}

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

  /** Fallos de autenticación por IP, para que no se pueda probar firmas a fuerza bruta. Se cuenta
   * SOLO el fallo: varios pilotos pueden compartir una misma salida a internet (una LAN party, un
   * CGNAT del proveedor) y limitar por volumen de requests legítimas los echaría a todos. */
  const fallos = new Map<string, { n: number; hasta: number }>();
  const MAX_FALLOS = 20;
  const VENTANA_MS = 5 * 60 * 1000;

  function demasiadosFallos(ip: string): boolean {
    const entry = fallos.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.hasta) {
      fallos.delete(ip);
      return false;
    }
    return entry.n >= MAX_FALLOS;
  }

  function anotarFallo(ip: string): void {
    const entry = fallos.get(ip);
    if (!entry || Date.now() > entry.hasta) fallos.set(ip, { n: 1, hasta: Date.now() + VENTANA_MS });
    else entry.n += 1;
  }

  function tokenDe(req: express.Request): string | undefined {
    const header = req.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim();
    return undefined;
  }

  /**
   * Autenticación ANTES del parser de JSON, a propósito.
   *
   * Parsear primero significa aceptar y procesar hasta 10 KB de JSON de cualquiera que descubra
   * el puerto. Rechazar antes de leer el cuerpo deja el gasto de un request inválido en casi nada.
   */
  app.use("/api/client", (req, res, next) => {
    const ip = req.ip || "desconocida";
    if (demasiadosFallos(ip)) {
      res.status(429).json({ ok: false, error: "Demasiados intentos." });
      return;
    }
    const guid = deps.verifyToken(tokenDe(req));
    if (guid) {
      (req as AuthedRequest).pilotGuid = guid;
      next();
      return;
    }
    anotarFallo(ip);
    // 401 y no 403: el cliente sabe qué hacer con esto —volver a entrar al servidor para que
    // el chat le mande un token nuevo— y así lo dice la app.
    res.status(401).json({ ok: false, error: "Credencial vencida: volvé a entrar al servidor." });
  });

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
    // Con token, el guid sale del token y el del cuerpo se ignora: si no coinciden es,
    // literalmente, alguien reportando en nombre de otro. Sin token (modo local) se usa el del
    // cuerpo, que es como venía funcionando.
    const acreditado = (req as AuthedRequest).pilotGuid;
    const delCuerpo = String(req.body?.steamGuid ?? "");
    if (acreditado && delCuerpo && delCuerpo !== acreditado) {
      res.status(403).json({ ok: false, error: "El token no corresponde a ese piloto." });
      return;
    }
    const steamGuid = acreditado || delCuerpo;
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
