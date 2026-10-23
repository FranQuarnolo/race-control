import * as http from "http";
import { Request, Response } from "express";

/**
 * Reenvía un request al worker de una liga, que escucha en loopback.
 *
 * Es `http.request` a mano y no una librería de proxy por una razón concreta: el request se
 * reenvía SIN haber tocado el cuerpo. Si el portal parseara el JSON antes, el stream quedaría
 * consumido y al worker le llegaría un POST vacío. Por eso el parser de JSON del portal se monta
 * solo en sus propias rutas (`/api/portal/*`) y nunca antes de esto.
 */
export function proxyToWorker(
  req: Request,
  res: Response,
  target: { port: number; path: string },
  extraHeaders: Record<string, string> = {}
): void {
  const headers: Record<string, string | string[]> = { ...req.headers } as Record<string, string | string[]>;
  // La cookie de sesión del portal no tiene nada que hacer del otro lado: el worker no la mira y
  // reenviarla solo agranda la superficie de un bug futuro.
  delete headers.cookie;
  delete headers.host;
  // Lo pone el portal y nadie más: si llegara de afuera, cualquiera firmaría sus acciones con el
  // nombre de otro y la auditoría dejaría de servir justo para lo que existe.
  delete headers["x-rc-user"];
  Object.assign(headers, extraHeaders);

  const upstream = http.request(
    { host: "127.0.0.1", port: target.port, method: req.method, path: target.path, headers },
    (upstreamRes) => {
      res.status(upstreamRes.statusCode || 502);
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined) res.setHeader(key, value as string | string[]);
      }
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (err) => {
    // El worker puede estar reiniciándose: 502 con un mensaje que se entienda, no una excepción.
    if (!res.headersSent) {
      res.status(502).json({ ok: false, error: `La liga no está respondiendo (${(err as NodeJS.ErrnoException).code || err.message}).` });
    } else {
      res.end();
    }
  });

  req.pipe(upstream);
}

/**
 * Pregunta interna al worker, sin request de por medio.
 *
 * La usa la pantalla de conexión para saber si ya está entrando telemetría. Devuelve `null` en
 * vez de tirar: que el worker todavía no responda es el estado normal durante los primeros
 * segundos, no un error que haya que mostrar.
 */
export function askWorker<T>(port: number, path: string, timeoutMs = 2000): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}
