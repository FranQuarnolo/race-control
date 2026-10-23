import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Autenticación del canal de pilotos.
 *
 * Hasta la 0.3 ese canal no tenía ninguna: cualquiera que supiera un SteamID podía mandar
 * telemetría en nombre de otro. En loopback no importaba — para llegar al puerto había que estar
 * en la misma PC. Expuesto a internet, sí importa.
 *
 * El esquema es un token firmado, sin estado del lado del servidor:
 *
 *     token = <kid>.<steamGuid>.<vencimiento>.<firma>
 *     firma = HMAC-SHA256(clave[kid], "rc1|" + steamGuid + "|" + vencimiento)
 *
 * El `steamGuid` va DENTRO de la firma, así que un piloto no puede usar su propio token para
 * hacerse pasar por otro: cambiar el guid invalida la firma. El `kid` permite rotar la clave sin
 * dejar a nadie afuera en el medio de una carrera (vale la vieja hasta que venzan sus tokens).
 *
 * Lo que este esquema NO resuelve, y se asume: el token viaja en claro, porque la app corre en el
 * Python 3.3 embebido de Assetto Corsa y ahí no hay HTTPS utilizable. Quien esté en la red de un
 * piloto puede capturarlo y falsificar la presencia y la telemetría DE ESE PILOTO durante 24 h.
 * No da acceso al panel ni a otra liga. Y hay algo que ningún token arregla: el piloto es dueño
 * de su PC, así que su telemetría nunca es autoritativa — por eso los límites de pista que
 * reporta la app se contrastan contra los `cuts` que cuenta el servidor de AC.
 */

const PREFIJO_FIRMA = "rc1|";
const VIGENCIA_MS = 24 * 60 * 60 * 1000;

/** Clave de liga: 32 bytes en `<dataDir>/secrets/pilot.key`, creada sola la primera vez. */
export class PilotTokenIssuer {
  private key: Buffer;
  private kid: string;

  constructor(dataDir: string) {
    const file = path.join(dataDir, "secrets", "pilot.key");
    if (fs.existsSync(file)) {
      this.key = fs.readFileSync(file);
    } else {
      this.key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // En Windows el modo se ignora; en Linux (el portal) es lo que impide que otro proceso del
      // mismo contenedor lea la clave de todas las ligas.
      fs.writeFileSync(file, this.key, { mode: 0o600 });
    }
    this.kid = crypto.createHash("sha256").update(this.key).digest("hex").slice(0, 6);
  }

  private sign(steamGuid: string, exp: number): string {
    return crypto
      .createHmac("sha256", this.key)
      .update(`${PREFIJO_FIRMA}${steamGuid}|${exp}`)
      .digest("base64url");
  }

  issue(steamGuid: string, now = Date.now()): string {
    const exp = Math.floor((now + VIGENCIA_MS) / 1000);
    return `${this.kid}.${steamGuid}.${exp}.${this.sign(steamGuid, exp)}`;
  }

  /** Devuelve el `steamGuid` que el token acredita, o `null` si no vale. */
  verify(token: string | undefined, now = Date.now()): string | null {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [kid, steamGuid, expRaw, firma] = parts;
    if (kid !== this.kid) return null;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp * 1000 < now) return null;

    const esperada = Buffer.from(this.sign(steamGuid, exp));
    const recibida = Buffer.from(firma);
    // La comparación en tiempo constante importa incluso acá: con suficientes intentos, el
    // tiempo de un `===` deja adivinar la firma byte a byte.
    if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
    return steamGuid;
  }
}

/** Separador entre la dirección y el token en el anuncio por chat. No puede aparecer en una URL,
 * que es por lo que no se usa `:` — la dirección ya trae uno cuando lleva puerto. */
export const ANNOUNCE_SEPARATOR = "|";
