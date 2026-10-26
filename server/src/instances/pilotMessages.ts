/**
 * Los avisos que el piloto ve dentro del juego, en la ventana "RC Mensajes".
 *
 * Hasta la 0.7 el único canal hacia el piloto era el chat del servidor, y la app mostraba
 * únicamente lo que empezara con "PENALIDAD". Eso dejaba afuera todo lo demás: las vueltas que el
 * servidor invalidaba por irse de pista, los avisos antes de la sanción, las sanciones anuladas.
 * El piloto manejaba a ciegas y se enteraba de todo al terminar la carrera.
 *
 * Es un tablero por piloto con secuencia incremental, igual que `LightEventTracker`: el cliente
 * hace polling y manda el último `seq` que vio, así no hace falta que el servidor sepa qué entregó
 * y qué no. Si la app se cierra y se vuelve a abrir, arranca de cero y ve lo que esté vigente.
 *
 * Por qué no reemplaza al chat: el chat le llega **a todos**, incluso a los pilotos que no tienen
 * la app instalada, y es la única garantía de que un sancionado se entere. Esto lo complementa,
 * con el detalle y la permanencia que el chat no tiene — el mensaje queda en pantalla en vez de
 * pasar volando entre dos líneas de "fulano se conectó".
 */

export type PilotMessageKind = "penalty" | "warning" | "info";

export interface PilotMessage {
  seq: number;
  kind: PilotMessageKind;
  text: string;
}

/**
 * Cuántos avisos se guardan por piloto.
 *
 * El cliente pregunta cada segundo, así que nunca necesita más de los últimos dos o tres. El resto
 * existe solo para el caso de que la app estuviera caída un rato: diez es de sobra, y pone un techo
 * a la memoria de una carrera larga con alguien muy prolífico en infracciones.
 */
const MAX_POR_PILOTO = 10;

/**
 * Tope de pilotos con mensajes vivos.
 *
 * Un servidor de liga tiene 24 autos; el margen cubre las reconexiones, que entran con el mismo
 * guid. El tope está por lo mismo que el de arriba: que una sesión de 8 horas no acumule memoria
 * sin techo. Cuando se llena, se descarta el piloto que hace más tiempo no recibe nada.
 */
const MAX_PILOTOS = 100;

export class PilotMessageBoard {
  private seq = 0;
  /** `Map` preserva el orden de inserción, que es lo que hace barato descartar al más viejo. */
  private porPiloto = new Map<string, PilotMessage[]>();

  push(driverGuid: string, kind: PilotMessageKind, text: string): void {
    if (!driverGuid || !text) return;
    this.seq += 1;
    const cola = this.porPiloto.get(driverGuid) ?? [];
    cola.push({ seq: this.seq, kind, text });
    if (cola.length > MAX_POR_PILOTO) cola.splice(0, cola.length - MAX_POR_PILOTO);

    // Se borra y se vuelve a poner para que quede al final del orden de inserción: así el que se
    // descarta al llenarse es siempre el que hace más tiempo no recibe nada.
    this.porPiloto.delete(driverGuid);
    this.porPiloto.set(driverGuid, cola);
    if (this.porPiloto.size > MAX_PILOTOS) {
      const masViejo = this.porPiloto.keys().next().value;
      if (masViejo !== undefined) this.porPiloto.delete(masViejo);
    }
  }

  /** Lo que este piloto todavía no vio. `afterSeq` es el último `seq` que el cliente confirmó. */
  since(driverGuid: string, afterSeq: number): PilotMessage[] {
    const cola = this.porPiloto.get(driverGuid);
    if (!cola) return [];
    return cola.filter((m) => m.seq > afterSeq);
  }

  /** Clasificación y carrera son dos pizarras distintas: lo de la qualy no se arrastra. */
  resetSession(): void {
    this.porPiloto.clear();
  }
}
