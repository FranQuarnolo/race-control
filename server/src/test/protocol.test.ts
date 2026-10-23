import { strict as assert } from "assert";
import { test } from "node:test";
import { decodePacket } from "../udp/protocol";

/** Arma un CLIENT_EVENT tal como lo emite el servidor de AC. */
function clientEvent(opts: {
  eventType: number;
  carId: number;
  otherCarId?: number;
  impactSpeed: number;
  world: [number, number, number];
  rel: [number, number, number];
}): Buffer {
  const hasOther = opts.otherCarId !== undefined;
  const buf = Buffer.alloc(3 + (hasOther ? 1 : 0) + 4 + 12 + 12);
  let o = 0;
  buf.writeUInt8(130, o++); // opcode CLIENT_EVENT
  buf.writeUInt8(opts.eventType, o++);
  buf.writeUInt8(opts.carId, o++);
  if (hasOther) buf.writeUInt8(opts.otherCarId!, o++);
  buf.writeFloatLE(opts.impactSpeed, o);
  o += 4;
  for (const v of [...opts.world, ...opts.rel]) {
    buf.writeFloatLE(v, o);
    o += 4;
  }
  return buf;
}

test("CLIENT_EVENT: choque contra otro auto trae el other_car_id y alinea el resto de los campos", () => {
  const packet = decodePacket(
    clientEvent({ eventType: 10, carId: 3, otherCarId: 9, impactSpeed: 42.5, world: [100, 2, -300], rel: [0.1, 0, 2.1] })
  );
  assert.ok(packet);
  assert.equal(packet!.type, "CLIENT_EVENT");
  const data = (packet as { data: any }).data;
  assert.equal(data.carId, 3);
  assert.equal(data.otherCarId, 9);
  // Si `other_car_id` se leyera siempre (o nunca), estos tres quedarían desfasados un byte y la
  // velocidad saldría un número absurdo. Son el canario de que el orden de lectura es correcto.
  assert.ok(Math.abs(data.impactSpeed - 42.5) < 0.001);
  assert.ok(Math.abs(data.worldPosition.x - 100) < 0.001);
  assert.ok(Math.abs(data.relPosition.z - 2.1) < 0.001);
});

test("CLIENT_EVENT: choque contra el entorno NO trae other_car_id", () => {
  const packet = decodePacket(
    clientEvent({ eventType: 11, carId: 7, impactSpeed: 88.25, world: [1, 2, 3], rel: [0, 0, -1.5] })
  );
  const data = (packet as { data: any }).data;
  assert.equal(data.carId, 7);
  assert.equal(data.otherCarId, undefined);
  assert.ok(Math.abs(data.impactSpeed - 88.25) < 0.001);
  assert.ok(Math.abs(data.relPosition.z + 1.5) < 0.001);
});

test("CLIENT_EVENT truncado no tumba el proceso", () => {
  // Contrato declarado de decodePacket: ante un paquete corrupto devuelve null, no lanza. Un
  // throw acá cortaría el loop de UDP entero y con él toda la carrera.
  const full = clientEvent({ eventType: 10, carId: 1, otherCarId: 2, impactSpeed: 10, world: [0, 0, 0], rel: [0, 0, 0] });
  for (let len = 1; len < full.length; len++) {
    assert.doesNotThrow(() => decodePacket(full.subarray(0, len)));
  }
});

// --------------------------------------------------------- cadenas y sesión

/** Cadena "ancha": largo en caracteres y después 4 bytes por carácter (UTF-32LE). */
function wide(text: string): Buffer {
  const points = [...text];
  const buf = Buffer.alloc(1 + points.length * 4);
  buf.writeUInt8(points.length, 0);
  points.forEach((c, i) => buf.writeUInt32LE(c.codePointAt(0)!, 1 + i * 4));
  return buf;
}

/** Cadena "angosta": largo en bytes y después un byte por carácter (ASCII). */
function narrow(text: string): Buffer {
  return Buffer.concat([Buffer.from([text.length]), Buffer.from(text, "ascii")]);
}

test("CAR_INFO trae las cinco cadenas anchas, y en otro orden que NEW_CONNECTION", () => {
  // Si alguna se leyera como angosta, el desfasaje se comería el resto del paquete y el nombre
  // del piloto saldría como basura. Por eso se verifica la ÚLTIMA cadena: es la que sobrevive
  // solo si las cuatro anteriores se leyeron con el ancho correcto.
  const packet = decodePacket(
    Buffer.concat([
      Buffer.from([54, 7, 1]), // opcode, carId, isConnected
      wide("ks_ferrari_488_gt3"),
      wide("0_rosso_corsa"),
      wide("Fulano Pérez"),
      wide("Escudería"),
      wide("76561198000000001"),
    ])
  );
  const data = (packet as { data: any }).data;
  assert.equal((packet as any).type, "CAR_INFO");
  assert.equal(data.carId, 7);
  assert.equal(data.isConnected, true);
  assert.equal(data.carModel, "ks_ferrari_488_gt3");
  assert.equal(data.driverName, "Fulano Pérez");
  assert.equal(data.driverGuid, "76561198000000001");
});

test("NEW_CONNECTION mezcla anchas y angostas: nombre y GUID anchos, modelo y skin angostos", () => {
  // Es la rareza del protocolo que más veces se transcribe mal. Un auto cuyo modelo saliera de
  // acá corrido deja al piloto sin logo de marca y sin identificar en la torre.
  const packet = decodePacket(
    Buffer.concat([
      Buffer.from([51]),
      wide("Mengano López"),
      wide("76561198000000002"),
      Buffer.from([4]), // carId
      narrow("ks_bmw_m3_e30"),
      narrow("00_racing"),
    ])
  );
  const data = (packet as { data: any }).data;
  assert.equal(data.driverName, "Mengano López");
  assert.equal(data.carId, 4);
  assert.equal(data.carModel, "ks_bmw_m3_e30");
  assert.equal(data.carSkin, "00_racing");
});

test("NEW_SESSION: la duración viene ANTES de las vueltas, y en minutos", () => {
  // Invertir estos dos campos no rompe nada visible: da una carrera "a 10 vueltas" sin reloj, que
  // es exactamente lo que parece una carrera por vueltas. El error se detecta mirando el panel y
  // pensando que la config del servidor está mal.
  const packet = decodePacket(
    Buffer.concat([
      Buffer.from([50, 4, 0, 0, 1]), // opcode, protocolo, índices de sesión, cantidad
      wide("Servidor de prueba"),
      narrow("ks_barcelona"),
      narrow("layout_gp"),
      narrow("Carrera"),
      Buffer.from([3]), // sessionType: carrera
      Buffer.from([0x0a, 0x00]), // 10 minutos
      Buffer.from([0x00, 0x00]), // 0 vueltas
      Buffer.from([0x3c, 0x00]), // 60 s de espera
      Buffer.from([22, 30]), // temperaturas
      narrow("3_clear"),
      Buffer.from([0x88, 0x13, 0x00, 0x00]), // 5000 ms corridos
    ])
  );
  const data = (packet as { data: any }).data;
  assert.equal(data.track, "ks_barcelona");
  assert.equal(data.trackConfig, "layout_gp");
  assert.equal(data.sessionType, 3);
  assert.equal(data.timeMinutes, 10, "la duración salió de donde van las vueltas");
  assert.equal(data.laps, 0);
  assert.equal(data.waitTimeSeconds, 60);
  assert.equal(data.ambientTemp, 22);
  assert.equal(data.roadTemp, 30);
  assert.equal(data.weatherGraphics, "3_clear");
  assert.equal(data.elapsedMs, 5000);
});

test("una cadena que dice ser más larga que el paquete devuelve null, no revienta", () => {
  const packet = Buffer.concat([Buffer.from([51]), Buffer.from([40]), Buffer.from("corto", "ascii")]);
  assert.equal(decodePacket(packet), null);
});
