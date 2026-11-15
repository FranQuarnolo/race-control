import { strict as assert } from "assert";
import { test } from "node:test";
import { BackendAnnouncer, BACKEND_ANNOUNCE_PREFIX } from "../udp/announcer";
import { AcUdpClient } from "../udp/client";

/**
 * La ronda de anuncios se reinicia cuando el piloto termina de cargar.
 *
 * El bug que lo originó: `NEW_CONNECTION` llega apenas el piloto se conecta, con el juego todavía
 * en la pantalla de carga, y la ronda (5 × 4 s) se terminaba antes de que la app existiera. La app
 * quedaba en "Buscando servidor de Race Control..." para siempre, con el mensaje
 * `RACECONTROL_BACKEND:` visible en el historial del chat. No falla nada: simplemente no pasa.
 */
function announcerFalso() {
  const enviados: Array<{ carId: number; texto: string }> = [];
  const udp = { sendChatToCar: (carId: number, texto: string) => enviados.push({ carId, texto }) };
  const announcer = new BackendAnnouncer(udp as unknown as AcUdpClient, () => "rc.example/l/liga", () => "tok");
  return { announcer, enviados };
}

test("CLIENT_LOADED vuelve a anunciar aunque la ronda de NEW_CONNECTION ya haya arrancado", () => {
  const { announcer, enviados } = announcerFalso();
  const piloto = { carId: 3, driverGuid: "7656" };

  announcer.onNewConnection(piloto);
  assert.equal(enviados.length, 1);

  announcer.onClientLoaded(piloto);
  assert.equal(enviados.length, 2, "terminar de cargar no reanunció: la app arranca con la ronda vencida");
  assert.equal(enviados[1].carId, 3);
  assert.equal(enviados[1].texto, `${BACKEND_ANNOUNCE_PREFIX}rc.example/l/liga|tok`);

  // El primer latido corta la ronda nueva: sin esto, el timer queda vivo y sigue mandando chat.
  announcer.onHeartbeatReceived("7656");
});
