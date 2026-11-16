// Server-side digging measured by native-dig-clock and P2b's uninterrupted native-dig probe.
import type { Vec3 } from "vec3";
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";
import type { FakeWorld } from "./fake-world.js";

/** A started dig is removed only after its mining ticks and a finish request; cancel forgets it. */
export function attachServerDigging(bot: FakeBot, server: FakeServer, world: FakeWorld): void {
  let pending: { position: Vec3; startedTick: number; ticks: number; finished: boolean } | undefined;
  const answer = () => {
    if (!pending?.finished || server.gameTime - pending.startedTick < pending.ticks) return;
    const { position } = pending;
    pending = undefined;
    world.setCell(position, "air");
    bot._client.emit("block_change", { location: position, type: 0 });
  };
  server.onTick(answer);
  server.onPacket("block_dig", data => {
    if (!bot._startServerDig) return;
    const packet = data as { status: number; location: Vec3 };
    if (packet.status === 0) {
      const block = world.blockAt(packet.location);
      if (block) pending = { position: block.position.clone(), startedTick: server.gameTime, ticks: Math.ceil(bot.digTime(block) / 50), finished: false };
    } else if (packet.status === 1) {
      pending = undefined;
    } else if (packet.status === 2 && pending?.position.equals(packet.location)) {
      pending.finished = true;
      server.answer(answer);
    }
  });
}
