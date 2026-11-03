import { createServer } from "node:net";

/** How many consecutive ports `freePort` tries, the start included. */
export const PORT_SEARCH_SPAN = 100;
const HIGHEST_PORT = 65_535;
/**
 * The addresses a holder of the port may use. Windows lets a bind on 127.0.0.1 succeed beside a program listening on
 * 0.0.0.0 or `::` (measured with Windows Bun 1.4.2), so one probe on the loopback address calls such a port free.
 */
const PROBED_ADDRESSES = ["127.0.0.1", "0.0.0.0", "::"] as const;
/** A machine without IPv6 answers these for `::`: nothing can hold the port there, so it is no reason to skip it. */
const ADDRESS_FAMILY_UNAVAILABLE = new Set(["EAFNOSUPPORT", "EADDRNOTAVAIL"]);

/** True when this process can listen on `port` of `address` right now (the probe socket is closed again). */
function canListenOn(port: number, address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => resolve(ADDRESS_FAMILY_UNAVAILABLE.has(error.code ?? "") && address === "::"));
    probe.listen(port, address, () => probe.close(() => resolve(true)));
  });
}

async function isPortFree(port: number): Promise<boolean> {
  for (const address of PROBED_ADDRESSES) {
    if (!(await canListenOn(port, address))) return false;
  }
  return true;
}

/**
 * The first port from `start` that is not in `taken` and that nobody listens on (loopback, any-IPv4 or any-IPv6),
 * within `PORT_SEARCH_SPAN` ports. The caller writes the answer back to its settings or its taken set: the port is
 * free now, not reserved.
 */
export async function freePort(start: number, taken: ReadonlySet<number> = new Set()): Promise<number> {
  if (!Number.isInteger(start) || start < 1 || start > HIGHEST_PORT) throw new RangeError(`${start} is not a TCP port: a start port is a whole number from 1 to ${HIGHEST_PORT}.`);
  const last = Math.min(start + PORT_SEARCH_SPAN - 1, HIGHEST_PORT);
  for (let port = start; port <= last; port++) {
    if (!taken.has(port) && (await isPortFree(port))) return port;
  }
  throw new Error(`No free port in ${start}-${last}. Close the programs using those ports, then start again.`);
}
