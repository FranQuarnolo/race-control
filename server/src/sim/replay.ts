import * as fs from "fs";
import * as dgram from "dgram";

/**
 * Reproduce una captura cruda (raw.bin, ver log/journal.ts RawCapture) mandando los mismos
 * datagramas a localhost, respetando (o acelerando) el timing original. Sirve para poner a
 * prueba el motor de detección con tráfico real sin necesitar un servidor de AC corriendo —
 * complementa (no reemplaza) el spike de protocolo contra un servidor real.
 *
 * Uso: node dist/sim/replay.js <ruta-a-raw.bin> [puertoDestino=12000] [velocidad=1]
 */
function main(): void {
  const [, , rawPath, portArg, speedArg] = process.argv;
  if (!rawPath) {
    console.error("Uso: node dist/sim/replay.js <ruta-a-raw.bin> [puertoDestino=12000] [velocidad=1]");
    process.exit(1);
  }
  const port = Number(portArg) || 12000;
  const speed = Number(speedArg) || 1;

  const buf = fs.readFileSync(rawPath);
  const socket = dgram.createSocket("udp4");

  let offset = 0;
  let prevTimestampUs: bigint | null = null;
  let packetsSent = 0;

  function sendNext(): void {
    if (offset >= buf.length) {
      console.log(`Replay terminado: ${packetsSent} paquetes.`);
      socket.close();
      return;
    }
    const tMonoUs = buf.readBigUInt64LE(offset);
    const len = buf.readUInt16LE(offset + 8);
    const payload = buf.subarray(offset + 10, offset + 10 + len);
    offset += 10 + len;

    const delayMs = prevTimestampUs === null ? 0 : Number(tMonoUs - prevTimestampUs) / 1000 / speed;
    prevTimestampUs = tMonoUs;

    setTimeout(() => {
      socket.send(payload, port, "127.0.0.1", () => {
        packetsSent += 1;
        sendNext();
      });
    }, Math.max(0, delayMs));
  }

  sendNext();
}

main();
