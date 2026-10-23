import * as assert from "assert";
import { describe, it } from "node:test";
import { Check, DiagnosticsInput, runDiagnostics, summarize } from "../net/diagnostics";

type Over = Partial<Omit<DiagnosticsInput, "network" | "udp">> & {
  network?: Partial<DiagnosticsInput["network"]>;
  udp?: Partial<DiagnosticsInput["udp"]>;
};

function input(over: Over = {}): DiagnosticsInput {
  const { network, udp, ...rest } = over;
  return {
    network: {
      publicIp: "200.1.2.3",
      publicHostSource: "detected",
      strategy: "direct",
      receivingTelemetry: true,
      clientPortMapped: true,
      upnpAttempted: false,
      upnpSuccess: null,
      lastCheckedAt: 0,
      ...(network || {}),
    },
    udp: {
      packetsReceived: 1200,
      packetsUnhandled: 0,
      lastPacketAt: Date.now(),
      commandsSent: 40,
      commandSendErrors: 0,
      lastSourcePort: 11000,
      ...(udp || {}),
    },
    remoteHost: "200.9.9.9",
    udpLocalPort: 12000,
    udpRemotePort: 11000,
    udpRemotePortSource: "detected",
    udpRemotePortUnstable: false,
    clientPort: 3001,
    driversConnected: 3,
    driversReporting: 3,
    ...rest,
  } as DiagnosticsInput;
}

function by(checks: Check[], id: string): Check {
  const found = checks.find((c) => c.id === id);
  assert.ok(found, `falta el chequeo ${id}`);
  return found as Check;
}

describe("runDiagnostics", () => {
  it("devuelve los cuatro chequeos, de afuera hacia adentro", () => {
    assert.deepStrictEqual(
      runDiagnostics(input()).map((c) => c.id),
      ["public-host", "telemetry", "commands", "drivers"]
    );
  });

  it("todo en orden: ningún chequeo pide hacer nada", () => {
    const checks = runDiagnostics(input());
    assert.ok(checks.every((c) => c.state === "ok"));
    assert.ok(checks.every((c) => c.action === ""));
    assert.strictEqual(summarize(checks).state, "ok");
  });

  it("todo chequeo que no esté en verde explica qué hacer o por qué esperar", () => {
    const checks = runDiagnostics(
      input({
        network: { publicIp: "", publicHostSource: "unknown", strategy: "direct" },
        udp: { packetsReceived: 0, lastPacketAt: 0, commandsSent: 0, commandSendErrors: 0 },
        remoteHost: "127.0.0.1",
        driversReporting: 0,
      })
    );
    for (const check of checks) {
      assert.notStrictEqual(check.state, "ok", `${check.id} no debería estar en verde acá`);
      assert.ok(check.detail.length > 0, `${check.id} no dice qué se observó`);
      if (check.state === "fail") assert.ok(check.action.length > 0, `${check.id} falla sin decir qué hacer`);
    }
  });

  it("sin dirección propia, manda a escribirla a mano", () => {
    const check = by(
      runDiagnostics(
        input({ network: { publicIp: "", publicHostSource: "unknown" } })
      ),
      "public-host"
    );
    assert.strictEqual(check.state, "fail");
    assert.match(check.action, /a mano/i);
  });

  it("distingue la dirección escrita a mano de la detectada", () => {
    const manual = by(
      runDiagnostics(
        input({ network: { publicIp: "1.2.3.4", publicHostSource: "manual" } })
      ),
      "public-host"
    );
    assert.match(manual.detail, /escribiste vos/i);
  });

  it("telemetría vieja es aviso, no falla: entre sesiones el servidor calla", () => {
    const check = by(
      runDiagnostics(
        input({ udp: { packetsReceived: 900, lastPacketAt: Date.now() - 60_000, commandsSent: 1, commandSendErrors: 0 } })
      ),
      "telemetry"
    );
    assert.strictEqual(check.state, "warn");
  });

  it("telemetría que nunca llegó manda a pegar las dos líneas y nombra el puerto", () => {
    const check = by(
      runDiagnostics(
        input({ udp: { packetsReceived: 0, lastPacketAt: 0, commandsSent: 0, commandSendErrors: 0 } })
      ),
      "telemetry"
    );
    assert.strictEqual(check.state, "fail");
    assert.match(check.action, /server_cfg\.ini/);
    assert.match(check.action, /12000/);
  });

  it("mientras la estrategia se está negociando, la telemetría queda en espera y no en rojo", () => {
    const check = by(
      runDiagnostics(
        input({
          network: { publicIp: "1.2.3.4", publicHostSource: "detected", strategy: "pending" },
          udp: { packetsReceived: 0, lastPacketAt: 0, commandsSent: 0, commandSendErrors: 0 },
        })
      ),
      "telemetry"
    );
    assert.strictEqual(check.state, "pending");
  });

  it("con el host remoto todavía en loopback, las órdenes no salen a ningún lado", () => {
    const check = by(runDiagnostics(input({ remoteHost: "127.0.0.1" })), "commands");
    assert.strictEqual(check.state, "fail");
  });

  // Un hosting que impone sus propios puertos (udp_plugin_local_port=8008) deja todo lo demás en
  // verde: la telemetría entra perfecta y los comandos "se mandan" sin error, a un puerto donde
  // nadie escucha. Es la falla más cara de diagnosticar del producto, así que el chequeo tiene que
  // nombrar los dos números y las dos salidas posibles.
  it("si el servidor habla desde otro puerto que al que le mandamos, lo dice con los dos números", () => {
    const check = by(
      runDiagnostics(input({ udp: { lastSourcePort: 8008 }, udpRemotePort: 11000, udpRemotePortSource: "manual" })),
      "commands"
    );
    assert.strictEqual(check.state, "fail");
    assert.match(check.detail, /8008/);
    assert.match(check.detail, /11000/);
    assert.match(check.action, /8008/);
    assert.match(check.action, /Listen Address/);
  });

  // Si el servidor no usa un puerto fijo, mandarlo a copiar "el número que vimos" es mandarlo a
  // copiar un número que ya cambió. Es el único caso en que hay que pedirle que vaya al panel.
  it("con un puerto de origen que cambia, no se ofrece un número para copiar", () => {
    const check = by(
      runDiagnostics(input({ udp: { lastSourcePort: 54321 }, udpRemotePortUnstable: true })),
      "commands"
    );
    assert.strictEqual(check.state, "fail");
    assert.doesNotMatch(check.action, /54321/);
    assert.match(check.action, /Listen Address/);
  });

  it("cuando el puerto se dedujo solo, el verde lo aclara: nadie tuvo que buscarlo", () => {
    const check = by(runDiagnostics(input({ udpRemotePortSource: "detected" })), "commands");
    assert.strictEqual(check.state, "ok");
    assert.match(check.detail, /él solo/);
  });

  it("el desajuste de puertos pesa más que el resto: no sirve de nada que lo demás esté verde", () => {
    const checks = runDiagnostics(
      input({ udp: { lastSourcePort: 8008 }, udpRemotePort: 11000, udpRemotePortSource: "manual" })
    );
    assert.strictEqual(summarize(checks).state, "fail");
    assert.strictEqual(by(checks, "telemetry").state, "ok");
  });

  it("mientras el servidor no habló, no se inventa un desajuste de puertos", () => {
    const check = by(
      runDiagnostics(input({ udp: { lastSourcePort: 0, commandsSent: 0 }, udpRemotePort: 11000 })),
      "commands"
    );
    assert.strictEqual(check.state, "pending");
  });

  it("errores de envío son aviso y nombran cuántos", () => {
    const check = by(
      runDiagnostics(
        input({ udp: { packetsReceived: 10, lastPacketAt: Date.now(), commandsSent: 5, commandSendErrors: 2 } })
      ),
      "commands"
    );
    assert.strictEqual(check.state, "warn");
    assert.match(check.detail, /^2 /);
  });

  it("sin nadie en pista no hay nada que comprobar sobre la app", () => {
    const check = by(runDiagnostics(input({ driversConnected: 0, driversReporting: 0 })), "drivers");
    assert.strictEqual(check.state, "pending");
  });

  it("si el puerto ya está mapeado, la culpa no es del router sino de la app que falta", () => {
    const check = by(runDiagnostics(input({ driversReporting: 0 })), "drivers");
    assert.strictEqual(check.state, "fail");
    assert.match(check.action, /instalar la app/i);
  });

  it("si el puerto no está mapeado, manda a abrirlo y dice cuál", () => {
    const check = by(
      runDiagnostics(
        input({
          driversReporting: 0,
          network: { publicIp: "1.2.3.4", publicHostSource: "detected", clientPortMapped: false },
        })
      ),
      "drivers"
    );
    assert.match(check.action, /3001 \(TCP\)/);
  });
});

describe("summarize", () => {
  it("una falla gana sobre cualquier aviso y es lo que se muestra", () => {
    const result = summarize([
      { id: "a", title: "Uno", state: "warn", detail: "d", action: "" },
      { id: "b", title: "Dos", state: "fail", detail: "d", action: "hacé esto" },
    ]);
    assert.strictEqual(result.state, "fail");
    assert.strictEqual(result.message, "Dos: hacé esto");
  });

  it("sin fallas, un aviso manda sobre lo que está en espera", () => {
    const result = summarize([
      { id: "a", title: "Uno", state: "pending", detail: "esperando", action: "" },
      { id: "b", title: "Dos", state: "warn", detail: "medio raro", action: "" },
    ]);
    assert.strictEqual(result.state, "warn");
    assert.strictEqual(result.message, "Dos: medio raro");
  });
});
