import assert from "node:assert/strict";
import test from "node:test";
import { laneOf } from "./lanes.ts";
import { shiftCommand, shiftPositionText, type CommandContext } from "./shift-command.ts";

const LANE_3 = laneOf(3);
const Z = LANE_3.offset.z;
const RENAMES = new Map([["Actor", "ActorL3"], ["Diver", "DiverL3"]]);
const RCON: CommandContext = { where: "rcon", cell: LANE_3.cell, renames: RENAMES };
const TICK: CommandContext = { where: "tick", cell: LANE_3.cell, renames: RENAMES };
/** The lane 3 cell as a selector box. */
const BOX = "x=-512,y=-64,z=1280,dx=2047,dy=383,dz=511";

function shifted(command: string, context: CommandContext = RCON): string {
  const result = shiftCommand(command, LANE_3.offset, context);
  assert.ok(result.ok, result.ok ? "" : `${command}: ${result.reason}`);
  return result.command;
}

function refusal(command: string, context: CommandContext = RCON): string {
  const result = shiftCommand(command, LANE_3.offset, context);
  assert.ok(!result.ok, `${command} was shifted to ${result.ok ? result.command : ""}`);
  return result.reason;
}

test("fill, setblock and summon move x and z by the lane offset and keep y", () => {
  assert.equal(shifted("fill -4 -60 0 -2 -60 0 minecraft:tall_seagrass[half=lower]"), "fill -4 -60 1536 -2 -60 1536 minecraft:tall_seagrass[half=lower]");
  assert.equal(shifted("setblock -1 -59 -3 glass"), "setblock -1 -59 1533 glass");
  assert.equal(shifted("summon zombie 25.5 -60 0.5"), "summon zombie 25.5 -60 1536.5");
  assert.equal(shifted("summon pig 0 -60 0 {NoAI:1b}"), "summon pig 0 -60 1536 {NoAI:1b}");
});

test("numbers inside block states and fill modes are not coordinates", () => {
  assert.equal(shifted("fill 0 -61 0 3 -61 3 stone_slab[type=bottom] replace"), "fill 0 -61 1536 3 -61 1539 stone_slab[type=bottom] replace");
  assert.equal(shifted("setblock 1 -60 1 snow[layers=3]"), "setblock 1 -60 1537 snow[layers=3]");
  assert.equal(shifted("fill 0 -60 0 1 -60 1 air replace snow[layers=3]"), "fill 0 -60 1536 1 -60 1537 air replace snow[layers=3]");
});

test("an integer stays an integer and a decimal keeps its decimals", () => {
  assert.equal(shifted("summon pig -16 -60 -0.25"), "summon pig -16 -60 1535.75");
  assert.equal(shifted("setblock 5 -60 -256 stone"), "setblock 5 -60 1280 stone");
});

test("a lane offset on x moves x as well", () => {
  const result = shiftCommand("setblock 1 -60 2 stone", { x: 512, z: 1024 }, { ...RCON, cell: { minX: 0, maxX: 2000, minZ: 700, maxZ: 1300 } });
  assert.deepEqual(result, { ok: true, command: "setblock 513 -60 1026 stone" });
});

test("clone moves all three triples", () => {
  assert.equal(shifted("clone 0 -60 0 5 -55 5 100 -60 0"), "clone 0 -60 1536 5 -55 1541 100 -60 1536");
  assert.equal(shifted("clone 0 -60 0 5 -55 5 100 -60 0 masked move"), "clone 0 -60 1536 5 -55 1541 100 -60 1536 masked move");
});

test("tp takes a triple alone, after a target, or none at all", () => {
  assert.equal(shifted("tp 1 -60 2"), "tp 1 -60 1538");
  assert.equal(shifted("teleport Actor 1.5 -60 2.5"), "teleport ActorL3 1.5 -60 1538.5");
  assert.equal(shifted("tp Actor Diver"), "tp ActorL3 DiverL3");
  assert.equal(shifted("tp @s 1 -60 2 facing 4 -60 4"), "tp @s 1 -60 1538 facing 4 -60 1540");
  assert.equal(shifted("tp Actor 1 -60 2 facing entity Diver"), "tp ActorL3 1 -60 1538 facing entity DiverL3");
});

test("forceload shifts its x z pairs and leaves all and query alone", () => {
  assert.equal(shifted("forceload add -16 -16"), "forceload add -16 1520");
  assert.equal(shifted("forceload add 0 0 32 32"), "forceload add 0 1536 32 1568");
  assert.equal(shifted("forceload remove 0 0 32 32"), "forceload remove 0 1536 32 1568");
  assert.equal(shifted("forceload remove all"), "forceload remove all");
  assert.equal(shifted("forceload query"), "forceload query");
  assert.equal(shifted("forceload query 0 0"), "forceload query 0 1536");
});

test("a selector with no position gets the lane cell box, one with a position keeps it shifted", () => {
  assert.equal(shifted("kill @e[type=!minecraft:player]"), `kill @e[type=!minecraft:player,${BOX}]`);
  assert.equal(shifted("kill @e"), `kill @e[${BOX}]`);
  assert.equal(shifted("gamemode spectator @a[name=!Actor,gamemode=!spectator]", TICK), `gamemode spectator @a[name=!ActorL3,gamemode=!spectator,${BOX}]`);
  assert.equal(shifted("kill @e[type=zombie,x=3,y=-60,z=4,dx=2,dy=2,dz=2]"), "kill @e[type=zombie,x=3,y=-60,z=1540,dx=2,dy=2,dz=2]");
});

test("@s is never boxed and its x z are shifted when it carries them", () => {
  assert.equal(shifted("tag @s add hungry", TICK), "tag @s add hungry");
  assert.equal(shifted("execute as Actor unless entity @s[x=0,y=-59,z=0,distance=..3] run effect give @s minecraft:hunger 2 255 true", TICK),
    "execute as ActorL3 unless entity @s[x=0,y=-59,z=1536,distance=..3] run effect give @s minecraft:hunger 2 255 true");
});

test("a selector in brackets with nested braces and commas is read as one argument list", () => {
  assert.equal(shifted("kill @e[type=item,nbt={Item:{id:\"minecraft:stone\",count:1}},x=1,y=-60,z=1,distance=..4]"),
    "kill @e[type=item,nbt={Item:{id:\"minecraft:stone\",count:1}},x=1,y=-60,z=1537,distance=..4]");
});

test("player names are renamed as whole words and in name= arguments, never inside a longer word", () => {
  assert.equal(shifted("effect give Actor minecraft:hunger 2 120 true", TICK), "effect give ActorL3 minecraft:hunger 2 120 true");
  assert.equal(shifted("execute if entity @a[name=Diver,x=1,y=-62,z=-1,dx=1,dy=3,dz=2] run fill 4 -61 0 4 -60 0 stone", TICK),
    "execute if entity @a[name=DiverL3,x=1,y=-62,z=1535,dx=1,dy=3,dz=2] run fill 4 -61 1536 4 -60 1536 stone");
  assert.equal(shifted("say ActorX Actors"), "say ActorX Actors");
});

test("execute walks its sub-commands left to right and shifts the ones holding positions", () => {
  assert.equal(shifted("execute positioned 1 2 3 run setblock ~ ~ ~ stone"), "execute positioned 1 2 1539 run setblock ~ ~ ~ stone");
  assert.equal(shifted("execute if block 1 -60 2 stone run say hi"), "execute if block 1 -60 1538 stone run say hi");
  assert.equal(shifted("execute unless block 1 -60 2 minecraft:air run say hi"), "execute unless block 1 -60 1538 minecraft:air run say hi");
  assert.equal(shifted("execute if blocks 0 0 0 1 1 1 5 5 5 all run say same"), "execute if blocks 0 0 1536 1 1 1537 5 5 1541 all run say same");
});

test("~ and ^ are accepted after at or as ... at @s, where the executor is a lane entity, and refused otherwise", () => {
  assert.equal(shifted("execute as Actor at @s run fill ~ ~ ~ ~ ~1 ~ air"), "execute as ActorL3 at @s run fill ~ ~ ~ ~ ~1 ~ air");
  assert.equal(shifted("execute at Actor run setblock ^ ^ ^1 stone"), "execute at ActorL3 run setblock ^ ^ ^1 stone");
  assert.equal(shifted("execute positioned as Actor run setblock ~ ~ ~ stone"), "execute positioned as ActorL3 run setblock ~ ~ ~ stone");
  assert.match(refusal("fill ~ ~ ~ ~ ~1 ~ air"), /relative/u);
  assert.match(refusal("tp Actor ~ ~ ~"), /relative/u);
  assert.match(refusal("execute as Actor run fill ~ ~ ~ ~ ~1 ~ air"), /relative/u);
  assert.match(refusal("execute positioned ~ ~ ~ run say hi"), /relative/u);
});

test("distance= needs a position: refused from rcon or a tick, accepted after at, left unboxed there", () => {
  assert.match(refusal("kill @e[type=zombie,distance=..5]"), /distance/u);
  assert.match(refusal("execute as @a[distance=..5] run say hi", TICK), /distance/u);
  assert.equal(shifted("execute at Actor run kill @e[type=zombie,distance=..5]"), "execute at ActorL3 run kill @e[type=zombie,distance=..5]");
});

test("dx dy dz without x y z measure from where the command runs and are refused", () => {
  assert.match(refusal("kill @e[dx=5,dy=5,dz=5]"), /dx/u);
});

test("a tick selector with x or z and no y is refused, because a command block and a tick function run at different heights", () => {
  assert.match(refusal("execute if entity @a[x=0,z=0,dx=3,dz=3] run say hi", TICK), /y/u);
  assert.equal(shifted("execute if entity @a[x=0,z=0,dx=3,dz=3] run say hi"), "execute if entity @a[x=0,z=1536,dx=3,dz=3] run say hi");
});

test("every command that changes the whole server is refused, also behind execute run", () => {
  for (const verb of ["tick rate 5", "time set noon", "weather clear", "gamerule doFireTick false", "difficulty hard", "setworldspawn 0 -60 0",
    "spawnpoint Actor 0 -60 0", "worldborder set 100", "reload", "datapack enable x", "function a:b"]) {
    assert.match(refusal(verb), /whole server|every lane/u, verb);
    assert.match(refusal(`execute as Actor at @s run ${verb}`), /whole server|every lane/u, verb);
  }
});

test("a verb the grammar does not know is refused when a number triple follows it", () => {
  assert.match(refusal("particle flame 1 2 3 0 0 0 0 1"), /particle/u);
  assert.match(refusal("data modify block 1 -60 1 Items set value []"), /data/u);
  assert.equal(shifted("effect give @s minecraft:speed 10 1 true", TICK), "effect give @s minecraft:speed 10 1 true");
  assert.equal(shifted("give Actor minecraft:stone 64"), "give ActorL3 minecraft:stone 64");
});

test("an execute sub-command the grammar does not know is refused instead of passed through", () => {
  assert.match(refusal("execute in the_nether run say hi"), /execute in/u);
  assert.match(refusal("execute if score Actor kills matches 1.. run say hi"), /score/u);
});

test("a command cut short is refused with what is missing", () => {
  assert.match(refusal("fill 1 2 3"), /incomplete/u);
  assert.match(refusal("execute"), /incomplete/u);
  assert.match(refusal("execute as"), /incomplete/u);
});

test("a leading slash is kept and the verb is still read", () => {
  assert.equal(shifted("/setblock 0 -60 0 stone"), "/setblock 0 -60 1536 stone");
  assert.match(refusal("/gamerule doFireTick false"), /whole server/u);
});

test("a position text is shifted as one triple, and refused when relative or not a triple", () => {
  assert.deepEqual(shiftPositionText("0 -60 -3", LANE_3.offset, RCON), { ok: true, command: "0 -60 1533" });
  assert.deepEqual(shiftPositionText("0.5 -60 0.5", LANE_3.offset, RCON), { ok: true, command: "0.5 -60 1536.5" });
  const relative = shiftPositionText("~ ~1 ~", LANE_3.offset, RCON);
  assert.ok(!relative.ok && /relative/u.test(relative.reason));
  const pair = shiftPositionText("1 2", LANE_3.offset, RCON);
  assert.ok(!pair.ok && /triple/u.test(pair.reason));
});

test("a selector with x y z but no volume and no bounded distance only moves its origin, so it is refused as reaching every lane", () => {
  assert.match(refusal("kill @e[type=zombie,x=0,y=-60,z=0]"), /every lane/u);
  assert.match(refusal("gamemode spectator @a[x=0,y=-60,z=0,name=!Actor]", TICK), /every lane/u);
  assert.match(refusal("execute as Actor at @s run kill @e[distance=2..]"), /upper bound/u);
  assert.equal(shifted("kill @e[type=zombie,x=0,y=-60,z=0,distance=..4]"), "kill @e[type=zombie,x=0,y=-60,z=1536,distance=..4]");
  assert.equal(shifted("execute as Actor at @s run kill @e[distance=2..5]"), "execute as ActorL3 at @s run kill @e[distance=2..5]");
});

test("a position that lands outside the lane's cell is refused, in a command, a selector and a forceload", () => {
  assert.match(refusal("tp Actor 0 -60 300"), /outside the lane's cell/u);
  assert.match(refusal("fill 0 -60 0 1 -60 -300 air"), /outside the lane's cell/u);
  assert.match(refusal("kill @e[x=0,y=-60,z=300,dx=3,dy=3,dz=3]"), /outside the lane's cell/u);
  assert.match(refusal("forceload add 0 300"), /outside the lane's cell/u);
  assert.match(refusal("setblock 5000 -60 0 stone"), /outside the lane's cell/u);
});

test("NBT and item components that hold a position are refused instead of passed through unshifted", () => {
  assert.match(refusal("summon villager 1 -60 1 {Brain:{memories:{\"minecraft:home\":{value:{pos:[I;5,-60,5]}}}}}"), /position/u);
  assert.match(refusal("give Actor compass[lodestone_tracker={target:{pos:[I;5,-60,5],dimension:\"minecraft:overworld\"}}]"), /position/u);
  assert.match(refusal("summon pig 1 -60 1 {Leash:{X:1,Y:2,Z:3}}"), /position/u);
  assert.equal(shifted("summon pig 1 -60 1 {NoAI:1b,PersistenceRequired:1b}"), `summon pig 1 -60 ${Z + 1} {NoAI:1b,PersistenceRequired:1b}`);
});

test("a quoted player name in name= is renamed like a bare one", () => {
  assert.equal(shifted('gamemode spectator @a[name=!"Actor"]', TICK), `gamemode spectator @a[name=!"ActorL3",${BOX}]`);
  assert.equal(shifted("kill @a[name='Actor']"), `kill @a[name='ActorL3',${BOX}]`);
});

test("scoreboards, teams, bossbars, schedules and command storage are shared by every lane and refused", () => {
  for (const command of ["scoreboard players set Actor kills 1", "team add red", "bossbar add a:b x", "schedule function a:b 1t", "data modify storage a:b x set value 1"]) {
    assert.match(refusal(command), /every lane|shares/u, command);
  }
});

test("a refusal says what to do: write the position out, or move a settings line to setup", () => {
  assert.match(refusal("summon zombie"), /written out/u);
  assert.match(refusal("gamerule doFireTick false"), /setup/u);
});

test("item replace and item modify shift the block position, and the source block of a from block", () => {
  assert.equal(shifted("item replace block 0 -60 0 container.0 with cobblestone 64"), `item replace block 0 -60 ${Z} container.0 with cobblestone 64`);
  assert.equal(shifted("item replace block 3 -60 -2 container.1 from block 0 -60 4 container.0"), `item replace block 3 -60 ${Z - 2} container.1 from block 0 -60 ${Z + 4} container.0`);
  assert.equal(shifted("item replace entity Actor weapon.mainhand with bow"), "item replace entity ActorL3 weapon.mainhand with bow");
  assert.equal(shifted("item replace entity @s weapon.mainhand from block 1 -60 1 container.0"), `item replace entity @s weapon.mainhand from block 1 -60 ${Z + 1} container.0`);
  assert.equal(shifted("item replace entity @a[name=Actor] weapon.mainhand from entity Diver weapon.offhand"), `item replace entity @a[name=ActorL3,${BOX}] weapon.mainhand from entity DiverL3 weapon.offhand`);
  assert.equal(shifted("item modify block 2 -60 2 container.0 minecraft:set_count"), `item modify block 2 -60 ${Z + 2} container.0 minecraft:set_count`);
  assert.equal(shifted("item modify entity Actor weapon.mainhand minecraft:set_count"), "item modify entity ActorL3 weapon.mainhand minecraft:set_count");
});

test("item replace block with ~ is accepted after at and refused from rcon", () => {
  assert.equal(shifted("execute as Actor at @s run item replace block ~ ~-1 ~ container.0 with stone"), "execute as ActorL3 at @s run item replace block ~ ~-1 ~ container.0 with stone");
  assert.match(refusal("item replace block ~ ~ ~ container.0 with stone"), /relative/u);
  assert.match(refusal("item replace block 0 -60"), /incomplete/u);
});
