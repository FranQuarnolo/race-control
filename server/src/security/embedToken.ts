import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Autenticación del embed en una página ajena (ej. fslmanager.vercel.app).
 *
 * Es un esquema distinto al de `pilotToken.ts` porque el riesgo es distinto: este token no viaja
 * en la red de un piloto, viaja pegado en el código fuente de una página de un tercero, visible
 * con "Ver código fuente" por cualquiera que la visite. No tiene sentido ponerle vencimiento —no
 * hay forma de rotarlo sola sin que el admin tenga que volver a pegar el snippet— así que la
 * firma no lleva fecha. Lo que sí tiene que ser instantáneo es la revocación, y por eso la firma
 * lleva un número de versión en vez de una identidad:
 *
 *     token = <kid>.<version>.<firma>
 *     firma = HMAC-SHA256(clave, "rce1|" + version)
 *
 * `version` se guarda en `config.embed.tokenVersion` (ver config.ts). Regenerar el token es
 * incrementar ese número: todo token emitido con la versión anterior deja de validar al toque,
 * sin tocar la clave de firma ni afectar a otra liga. `verify` recibe la versión vigente desde
 * afuera (no la guarda este objeto) para no abrir una segunda fuente de verdad con `config.json`.
 */

const PREFIJO_FIRMA = "rce1|";

/** Clave de liga: 32 bytes en `<dataDir>/secrets/embed.key`, creada sola la primera vez. */
export class EmbedTokenIssuer {
  private key: Buffer;
  private kid: string;

  constructor(dataDir: string) {
    const file = path.join(dataDir, "secrets", "embed.key");
    if (fs.existsSync(file)) {
      this.key = fs.readFileSync(file);
    } else {
      this.key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // En Windows el modo se ignora; en Linux (el portal) es lo que impide que otro proceso del
      // mismo contenedor lea la clave de otra liga.
      fs.writeFileSync(file, this.key, { mode: 0o600 });
    }
    this.kid = crypto.createHash("sha256").update(this.key).digest("hex").slice(0, 6);
  }

  private sign(version: number): string {
    return crypto.createHmac("sha256", this.key).update(`${PREFIJO_FIRMA}${version}`).digest("base64url");
  }

  issue(version: number): string {
    return `${this.kid}.${version}.${this.sign(version)}`;
  }

  /** `true` solo si el token fue firmado con la clave de esta liga PARA la versión vigente. */
  verify(token: string | undefined, currentVersion: number): boolean {
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [kid, versionRaw, firma] = parts;
    if (kid !== this.kid) return false;
    const version = Number(versionRaw);
    if (!Number.isFinite(version) || version !== currentVersion) return false;

    const esperada = Buffer.from(this.sign(version));
    const recibida = Buffer.from(firma);
    // Tiempo constante por la misma razón que en pilotToken.ts: con suficientes intentos, un
    // `===` deja adivinar la firma byte a byte.
    if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return false;
    return true;
  }
}
