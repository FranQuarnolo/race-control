import * as fs from "fs";
import * as path from "path";

/**
 * Journal de eventos de una sesión: append-only, un JSON por línea. Es la fuente de auditoría
 * ("¿por qué se sancionó a este piloto?") y, a futuro, de reconstrucción de estado tras un
 * reinicio del backend a mitad de carrera.
 */
export class Journal {
  private stream: fs.WriteStream;
  private seq = 0;

  constructor(logDir: string) {
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.stream = fs.createWriteStream(path.join(logDir, `events-${stamp}.jsonl`), { flags: "a" });
  }

  log(type: string, data: Record<string, unknown> = {}): void {
    this.seq += 1;
    const entry = { seq: this.seq, tWall: new Date().toISOString(), type, ...data };
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  close(): void {
    this.stream.end();
  }
}

/**
 * Captura cruda de datagramas UDP recibidos, sin decodificar. Sirve para auditar el spike de
 * protocolo (reprocesar la misma captura si se corrige el decoder) y como fuente del modo replay.
 * Formato por registro: [u64 tMono_us LE][u16 len LE][bytes del datagrama].
 */
export class RawCapture {
  private stream: fs.WriteStream;

  constructor(logDir: string, clockNowMs: () => number) {
    fs.mkdirSync(logDir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(logDir, "raw.bin"), { flags: "a" });
    this.clockNowMs = clockNowMs;
  }

  private clockNowMs: () => number;

  record(buf: Buffer): void {
    const header = Buffer.alloc(10);
    header.writeBigUInt64LE(BigInt(Math.round(this.clockNowMs() * 1000)), 0);
    header.writeUInt16LE(buf.length, 8);
    this.stream.write(Buffer.concat([header, buf]));
  }

  close(): void {
    this.stream.end();
  }
}
