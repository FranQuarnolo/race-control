import * as dgram from "dgram";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createRaceControl } from "../core/raceControl";
import { loadConfig, setConfigDir } from "../config";
import { Incident } from "../incident/incidentEngine";

/**
 * Levanta el panel con una carrera inventada adentro, para sacarle capturas.
 *
 * Existe por la landing: vender el producto con maquetas dibujadas a mano es mentir dos veces —
 * primero sobre cómo se ve, y después sobre lo que hace. Las imágenes de `portal/public/capturas`
 * salen de acá, así que son el panel de verdad con datos de verdad; lo único inventado son los
 * pilotos. Cuando el panel cambie, se vuelve a correr esto y las capturas quedan al día.
 *
 * No toca la red: no hay servidor de Assetto Corsa, no entra un solo paquete UDP. Se le escribe
 * directo a los mismos objetos que alimentaría el tráfico real.
 *
 * Uso: node dist/sim/demo.js [puerto=3900]
 */

const PILOTOS = [
  { nombre: "Matías Ferreyra", auto: "ks_porsche_911_gt3_r_2016", vueltaMs: 94_312 },
  { nombre: "Lucía Benegas", auto: "ks_ferrari_488_gt3", vueltaMs: 94_588 },
  { nombre: "Diego Sanz", auto: "ks_audi_r8_lms_2016", vueltaMs: 94_901 },
  { nombre: "Ariel Kuznetsov", auto: "ks_mercedes_amg_gt3", vueltaMs: 95_104 },
  { nombre: "Tomás Oyarzún", auto: "ks_lamborghini_huracan_gt3", vueltaMs: 95_377 },
  { nombre: "Nahuel Ibarra", auto: "ks_bmw_m6_gt3", vueltaMs: 95_612 },
  { nombre: "Paula Grimaldi", auto: "ks_nissan_gtr_gt3", vueltaMs: 95_890 },
  { nombre: "Ezequiel Roldán", auto: "ks_mclaren_650_gt3", vueltaMs: 96_244 },
  { nombre: "Franco Deleón", auto: "ks_porsche_911_gt3_r_2016", vueltaMs: 96_501 },
  { nombre: "Santiago Vera", auto: "ks_ferrari_488_gt3", vueltaMs: 97_030 },
];

/** SteamID64 ficticios pero con la forma real, para que nada los rechace por formato. */
function guidDe(i: number): string {
  return String(76561190000000000n + BigInt(i + 1));
}

const COMPUESTOS = ["Soft", "Soft", "Medium", "Medium", "Medium", "Hard", "Medium", "Soft", "Hard", "Medium"];

/**
 * Un trazado inventado con la forma de un circuito: dos rectas y curvas de radio variable.
 *
 * El mapa en vivo se dibuja con lo que el motor aprendió de las posiciones de los autos, así que
 * sin esto la captura muestra "Aprendiendo el circuito: 0%" — que es cierto, pero no es lo que el
 * producto hace. Se le pasan las muestras al mismo `TrackLearner` que alimentaría el UDP real.
 */
function puntoDelTrazado(s: number): { x: number; z: number } {
  const a = s * 2 * Math.PI;
  return {
    x: 760 * Math.cos(a) + 190 * Math.cos(3 * a) - 80 * Math.sin(2 * a),
    z: 470 * Math.sin(a) - 230 * Math.sin(2 * a) + 60 * Math.cos(4 * a),
  };
}

async function main(): Promise<void> {
  const puerto = Number(process.argv[2]) || 3900;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-demo-"));
  setConfigDir(dataDir);
  const config = loadConfig();
  config.leagueName = "Copa Panamericana GT3";
  config.http.publicHost = "203.0.113.5";
  config.acUdp.remoteHost = "198.51.100.22";
  config.acUdp.remotePortSource = "detected";
  config.shadowMode = false;
  config.preset = "campeonato";

  const rc = await createRaceControl({ config, dataDir, ports: { adminPort: puerto, clientPort: puerto + 1 } });

  // --- el circuito ----------------------------------------------------------------------------
  rc.trackLearner.setTrack("ks_red_bull_ring");
  for (let i = 0; i < 1400; i++) {
    const s = i / 1400;
    const p = puntoDelTrazado(s);
    rc.trackLearner.onCarUpdate({ posX: p.x, posZ: p.z, normalizedSplinePosition: s });
  }

  // --- la parrilla ----------------------------------------------------------------------------
  const ahora = Date.now();
  const splineDe = (i: number) => Math.max(0.02, 0.86 - i * 0.082);

  PILOTOS.forEach((piloto, i) => {
    const carId = i + 1;
    rc.stateTracker.onNewConnection({
      carId,
      driverName: piloto.nombre,
      driverGuid: guidDe(i),
      carModel: piloto.auto,
      carSkin: "default",
    } as never);
    // Cuatro vueltas cerradas para todos: así la torre tiene tiempos y no una columna de guiones.
    for (let v = 0; v < 4; v++) {
      rc.stateTracker.onLapCompleted({
        carId,
        lapTimeMs: piloto.vueltaMs + (v === 2 ? 0 : 400 + v * 230),
        cuts: 0,
      } as never);
    }
  });

  // La bandera ondea en `race` y media pantalla cambia de color según la fase: una captura en
  // `idle` mostraría el panel apagado, que es justo lo contrario de lo que hay que mostrar.
  rc.formationStart.beginFormation();
  rc.formationStart.triggerGreen();
  rc.phaseTracker.set("race");

  /**
   * Los autos se mueven y los pilotos siguen reportando.
   *
   * No es cosmético: el panel marca en rojo la telemetría que no se refresca y blanquea los datos
   * de la app a los 15 segundos. Un estado puesto una sola vez al arrancar se ve exactamente igual
   * que una liga rota.
   */
  const latir = () => {
    PILOTOS.forEach((piloto, i) => {
      const carId = i + 1;
      // Las posiciones no avanzan: cada auto se queda en su punto de la vuelta. En carrera la
      // torre se ordena por quién va más adelante, así que mover los autos reordenaba la tabla
      // cada pocos segundos —y en cuanto el líder cruzaba la meta, pasaba a figurar último—.
      // Lo que sí se repite es el envío, porque un auto sin refrescar se marca en rojo.
      const s = splineDe(i);
      const p = puntoDelTrazado(s);
      rc.stateTracker.onCarUpdate({
        carId,
        speedKmh: 212 - i * 3,
        posX: p.x,
        posY: 0,
        posZ: p.z,
        normalizedSplinePosition: s,
      } as never);
      rc.presenceWatchdog.onHeartbeat(guidDe(i), 28 + i * 4);
      rc.telemetryStore.report(guidDe(i), {
        sectors: [28_410 + i * 90, 33_980 + i * 110, 31_900 + i * 70],
        currentSector: i % 3,
        tyreCompound: COMPUESTOS[i],
        fuelLiters: 44.5 - i * 1.7,
        pitStops: i < 4 ? 1 : 0,
        inPitLane: false,
        tyresOut: 0,
        surfaceGrip: 0.98,
      });
    });
  };
  latir();
  const pulso = setInterval(latir, 500);

  /**
   * Un datagrama por segundo al propio puerto UDP, para que el panel diga "recibiendo".
   *
   * El indicador de señal lee los contadores del socket, no una variable: la única forma honesta
   * de ponerlo en verde es que entren paquetes de verdad. El contenido no importa —se descarta al
   * no decodificar— y el host del servidor ya está fijado, así que esto no se adopta como destino.
   *
   * Se bindea al puerto que la config declara como el del servidor de AC: si saliera de un puerto
   * efímero distinto cada vez, el motor concluiría —con razón— que el servidor no tiene un puerto
   * fijo, y el diagnóstico se pondría en rojo.
   */
  const pinger = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => pinger.bind(config.acUdp.remotePort, "127.0.0.1", resolve));
  const senal = setInterval(() => {
    pinger.send(Buffer.from([0xff]), config.acUdp.localPort, "127.0.0.1");
  }, 1000);

  // --- la bandeja de incidentes ---------------------------------------------------------------
  const incidente = (
    id: number,
    kind: Incident["kind"],
    partes: number[],
    extra: Partial<Incident>
  ): Incident => ({
    id: "I" + id,
    kind,
    createdAt: ahora - (9 - id) * 47_000,
    parties: partes.map((i) => ({
      carId: i + 1,
      driverGuid: guidDe(i),
      driverName: PILOTOS[i].nombre,
      speedKmh: 180 - i * 7,
    })),
    geometry: "unknown",
    impactCount: 1,
    lap: 3,
    splinePosition: 0.41,
    phase: "race",
    status: "pending",
    ...extra,
  });

  rc.incidentEngine.restore([
    incidente(1, "car-contact", [3, 6], {
      geometry: "rear-end",
      impactSpeedKmh: 64,
      impactCount: 2,
      lap: 2,
      splinePosition: 0.18,
      status: "penalized",
      resolvedAt: ahora - 280_000,
      resolution: "Drive-through: toque evitable en la frenada de la curva 1",
    }),
    incidente(2, "track-limits", [8], {
      detail: "4 salidas de pista en la vuelta",
      lap: 2,
      splinePosition: 0.73,
      status: "warned",
      resolvedAt: ahora - 190_000,
      resolution: "Aviso por límites de pista",
    }),
    incidente(3, "env-collision", [9], {
      impactSpeedKmh: 91,
      lap: 3,
      splinePosition: 0.52,
      status: "dismissed",
      resolvedAt: ahora - 120_000,
      resolution: "Sin consecuencias para terceros",
    }),
    incidente(4, "car-contact", [1, 4], {
      geometry: "side-by-side",
      impactSpeedKmh: 38,
      impactCount: 3,
      lap: 4,
      splinePosition: 0.64,
    }),
    incidente(5, "track-limits", [7], { detail: "3 salidas de pista en la vuelta", lap: 4, splinePosition: 0.29 }),
    incidente(6, "car-contact", [2, 5], { geometry: "rear-end", impactSpeedKmh: 72, lap: 4, splinePosition: 0.88 }),
  ]);

  // --- sanciones en curso ---------------------------------------------------------------------
  rc.stewardPenaltyEngine.issuePenalty(4, guidDe(3), "Toque evitable en la curva 1", "DT", { incidentId: "I1" });
  rc.pitPenaltyEngine.issuePenalty(7, guidDe(6), "Exceso de velocidad en pit lane (63 km/h)", "DT");
  rc.formationPenaltyEngine.issuePenalty(10, guidDe(9), "Adelantamiento antes de la bandera verde", "SG");

  // --- a escuchar -----------------------------------------------------------------------------
  const server = http.createServer(rc.adminApp as unknown as http.RequestListener);
  await new Promise<void>((resolve) => server.listen(puerto, "127.0.0.1", resolve));
  console.log(`[demo] Panel de demostración en http://127.0.0.1:${puerto}/`);
  console.log(`[demo] Datos en ${dataDir} — se borran al cerrar con Ctrl+C.`);

  const cerrar = () => {
    clearInterval(pulso);
    clearInterval(senal);
    pinger.close();
    server.close();
    rc.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", cerrar);
  process.on("SIGTERM", cerrar);
}

main().catch((err) => {
  console.error("[demo] No se pudo levantar:", err);
  process.exit(1);
});
