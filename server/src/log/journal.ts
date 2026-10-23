import * as fs from "fs";
import * as path from "path";

/**
 * Journal de eventos de una sesión: append-only, un JSON por línea. Es la fuente de auditoría
 * ("¿por qué se sancionó a este piloto?") y, a futuro, de reconstrucción de estado tras un
 * reinicio del backend a mitad de carrera.
 */
export class Journal {
  /** Escritura sincrónica, no `WriteStream`. El journal es la fuente de la restauración tras un
   * cierre a mitad de carrera, y el buffer de un stream se pierde entero si el proceso se corta
   * sin cerrarlo —que es exactamente el caso que la restauración existe para cubrir—. Son unos
   * pocos eventos por vuelta: el costo de escribir sincrónico no se nota. */
  private fd: number;
  private seq = 0;
  /** El archivo de ESTE arranque. Lo necesita la restauración para no leerse a sí misma. */
  readonly filePath: string;

  constructor(logDir: string) {
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = path.join(logDir, `events-${stamp}.jsonl`);
    this.fd = fs.openSync(this.filePath, "a");
  }

  log(type: string, data: Record<string, unknown> = {}): void {
    this.seq += 1;
    const entry = { seq: this.seq, tWall: new Date().toISOString(), type, ...data };
    try {
      fs.writeSync(this.fd, JSON.stringify(entry) + "\n");
    } catch {
      // Perder una línea de auditoría es malo; cortar la carrera por eso es peor.
    }
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // Ya cerrado: cerrar dos veces no es un error que le importe a nadie.
    }
  }
}

/**
 * Captura cruda de datagramas UDP recibidos, sin decodificar. Sirve para auditar el spike de
 * protocolo (reprocesar la misma captura si se corrige el decoder) y como fuente del modo replay.
 * Formato por registro: [u64 tMono_us LE][u16 len LE][bytes del datagrama].
 */
/** Tamaño a partir del cual `raw.bin` se archiva y se empieza uno nuevo. Con telemetría a 200 ms
 * y 24 autos son unos 40 MB por hora de carrera, así que 64 MB es aproximadamente una carrera y
 * media: el corte cae entre eventos, no en el medio de uno. */
const RAW_ROTATE_BYTES = 64 * 1024 * 1024;
/** Cuántos archivos viejos se conservan. Es memoria de la última carrera o dos —que es para lo
 * único que sirve el replay— y no un historial: el disco del admin no es nuestro. */
const RAW_KEEP_FILES = 3;

export interface RawCaptureOptions {
  rotateBytes?: number;
  keepFiles?: number;
}

export class RawCapture {
  /** Descriptor y no un `WriteStream`: `stream.end()` cierra el archivo de forma asincrónica, y en
   * Windows renombrar un archivo que todavía está abierto falla con EBUSY. Con el stream la
   * rotación quedaba atrapada en su propio `catch` y no rotaba nunca —justo en el único sistema
   * operativo donde corre esto—. `closeSync` cierra antes de volver, y el renombre funciona. */
  private fd: number;
  private written = 0;
  private rotateBytes: number;
  private keepFiles: number;

  constructor(private logDir: string, clockNowMs: () => number, options: RawCaptureOptions = {}) {
    fs.mkdirSync(logDir, { recursive: true });
    this.clockNowMs = clockNowMs;
    this.rotateBytes = options.rotateBytes ?? RAW_ROTATE_BYTES;
    this.keepFiles = options.keepFiles ?? RAW_KEEP_FILES;
    const current = this.currentPath();
    // Se parte del tamaño que ya tiene en disco: si no, cada reinicio reiniciaría el contador y
    // el archivo crecería sin límite igual, que es exactamente el problema que esto resuelve.
    this.written = sizeOf(current);
    this.fd = fs.openSync(current, "a");
  }

  private clockNowMs: () => number;

  private currentPath(): string {
    return path.join(this.logDir, "raw.bin");
  }

  record(buf: Buffer): void {
    const header = Buffer.alloc(10);
    header.writeBigUInt64LE(BigInt(Math.round(this.clockNowMs() * 1000)), 0);
    header.writeUInt16LE(buf.length, 8);
    const record = Buffer.concat([header, buf]);
    // Se rota ANTES de escribir, nunca en el medio: un registro partido entre dos archivos no lo
    // puede leer ni el replay ni nadie.
    if (this.written + record.length > this.rotateBytes) this.rotate();
    try {
      fs.writeSync(this.fd, record);
      this.written += record.length;
    } catch {
      // La captura cruda es material de diagnóstico: que falle una escritura no justifica cortar
      // el procesamiento del datagrama, que es lo que dirige la carrera.
    }
  }

  private rotate(): void {
    try {
      fs.closeSync(this.fd);
      fs.renameSync(this.currentPath(), this.archivePath());
      this.pruneOld();
    } catch {
      // Si el archivo está tomado por otro programa (un antivirus leyéndolo, por ejemplo), seguir
      // escribiendo en el mismo es mucho mejor que tumbar la carrera por un problema de disco.
    }
    this.written = 0;
    this.fd = fs.openSync(this.currentPath(), "a");
  }

  /** Nombre del archivo archivado. El sufijo numérico existe porque dos rotaciones dentro del
   * mismo milisegundo —posible con un `rotateBytes` chico— generarían el mismo nombre y el
   * segundo `rename` pisaría al primero sin decir nada. */
  private archivePath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let candidate = path.join(this.logDir, `raw-${stamp}.bin`);
    for (let n = 1; fs.existsSync(candidate); n++) {
      candidate = path.join(this.logDir, `raw-${stamp}-${n}.bin`);
    }
    return candidate;
  }

  private pruneOld(): void {
    const archived = fs
      .readdirSync(this.logDir)
      .filter((name) => /^raw-.+\.bin$/.test(name))
      .sort();
    for (const name of archived.slice(0, Math.max(0, archived.length - this.keepFiles))) {
      try {
        fs.unlinkSync(path.join(this.logDir, name));
      } catch {
        // Borrar es best-effort: que no se pueda no es motivo para interrumpir nada.
      }
    }
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // Ya cerrado: cerrar dos veces no es un error que le importe a nadie.
    }
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export interface RetentionPolicy {
  /** Días que se conservan los `events-*.jsonl`. Tienen nombres y SteamID64 en texto plano. */
  eventsDays: number;
  /** Días que se conservan los `raw-*.bin` archivados. */
  rawDays: number;
}

/**
 * Borra los logs viejos de una liga. Se llama al arrancar y una vez por día.
 *
 * Race Control corre en un servidor compartido y guarda nombres y SteamID64 de pilotos de ligas
 * ajenas: conservarlos para siempre es lo que no se puede defender. Por eso la política de
 * retención se pasa explícita y no hay forma de desactivarla.
 *
 * El `raw.bin` en curso no se toca: se lo lleva la rotación por tamaño. Es material de
 * diagnóstico binario, no una lista de nombres.
 */
export function pruneOldLogs(logDir: string, policy: RetentionPolicy): number {
  const ahora = Date.now();
  const limite = (dias: number) => ahora - dias * 24 * 60 * 60 * 1000;
  let borrados = 0;

  let nombres: string[];
  try {
    nombres = fs.readdirSync(logDir);
  } catch {
    return 0;
  }

  for (const nombre of nombres) {
    let corte: number;
    if (/^events-.+\.jsonl$/.test(nombre)) corte = limite(policy.eventsDays);
    else if (/^raw-.+\.bin$/.test(nombre)) corte = limite(policy.rawDays);
    else continue;

    const file = path.join(logDir, nombre);
    try {
      // `mtime` y no la fecha del nombre: el nombre dice cuándo EMPEZÓ el archivo, y un journal de
      // una carrera larga se sigue escribiendo horas después. Lo que importa es la última línea.
      if (fs.statSync(file).mtimeMs >= corte) continue;
      fs.unlinkSync(file);
      borrados += 1;
    } catch {
      // Un archivo tomado por otro proceso se reintenta mañana. No vale interrumpir el arranque.
    }
  }
  return borrados;
}
