import assert from "node:assert/strict";
import test from "node:test";
import { describeStep, describeStepError, skillUsage, stepSchema } from "./actions.ts";
import { catalogueLine } from "./building/plan.ts";
import { templateFor, type Template } from "./building/templates.ts";

/** The templates of two families, as a fixture registry: two of the medieval persona's own, one of another family. */
const fixture: ReadonlyMap<string, Template> = new Map(["medieval-small", "rustic-small", "japanese-small"].map((id) => [id, templateFor(id)!]));

test("a build gives a template of any family or a size, never both; with neither it is the persona's small house", () => {
  const step = stepSchema.parse({ skill: "build", template: "japanese-small" });
  assert.equal(step.skill === "build" && step.template, "japanese-small");
  assert.equal(describeStep(stepSchema.parse({ skill: "build", template: "japanese-small", own: true })), "build the japanese-small house for yourself");
  assert.equal(stepSchema.safeParse({ skill: "build", template: "no-such-house" }).success, false, "the template is one of the registry's ids");
  const refused = stepSchema.safeParse({ skill: "build", template: "medieval-small", size: "small" });
  assert.equal(refused.success, false);
  assert.match(refused.error ? describeStepError({ skill: "build" }, refused.error) : "", /give template or size, not both/u);
  assert.equal(stepSchema.safeParse({ skill: "build", size: "large" }).success, false, "a size is small or medium");
  const bare = stepSchema.parse({ skill: "build" });
  assert.deepEqual([bare.skill === "build" && bare.template, bare.skill === "build" && bare.size], [undefined, undefined]);
  assert.equal(describeStep(bare), "build a small house");
  assert.equal(describeStep(stepSchema.parse({ skill: "build", size: "medium", x: 1, y: 64, z: 2 })), "build a medium house at 1 64 2");
});

test("list_houses takes a family, abandon_house nothing", () => {
  const step = stepSchema.parse({ skill: "list_houses", family: "africa" });
  assert.equal(describeStep(step), "look up the africa houses");
  assert.equal(stepSchema.safeParse({ skill: "list_houses" }).success, false);
  assert.equal(stepSchema.safeParse({ skill: "list_houses", family: "" }).success, false);
  assert.equal(stepSchema.safeParse({ skill: "list_houses", family: "x".repeat(41) }).success, false, "a family name is short");
  assert.equal(describeStep(stepSchema.parse({ skill: "abandon_house" })), "give up your unfinished house");
  assert.equal(stepSchema.safeParse({ skill: "abandon_house", extra: 1 }).success, false);
});

test("the build line lists the own family's houses, names the other families and how to read them", () => {
  const own = ["medieval-small", "rustic-small"].map((id) => catalogueLine(templateFor(id)!)).join("\n    ");
  assert.equal(skillUsage("build", "europe", fixture), `{"skill":"build","template":"<id>"}  build a house where you stand, its door facing whoever asked; add "x","y","z" (the door, at walking level) to build it at a given place: it walks there itself; it levels its own site first (trees, slopes, holes) and builds in stages (floor, walls, roof...): send it first, before fetching anything: it starts when you carry the first stage's blocks, and otherwise its result names exactly what the next stage lacks (fetch exactly that); it stops between stages the same way, and the step its result gives goes on. Your europe houses:
    ${own}
Other house families you know: east-asia: {"skill":"list_houses","family":"<family>"} shows their houses. {"skill":"build","size":"<small|medium>"} is short for your own small or medium house (give template or size, not both). Add "materials":{"<role>":"<block id>"} (roles: foundation, floor, wall, pillar, trim, roof, window, door, accent, railing) to build some parts with other blocks you carry (a full block for every role but window, door, accent and railing; window, accent and railing may be "air"; a door must be a door block); those parts are built with full blocks, and the house is then temporary: improve_house later swaps them for the house's own; add "own":true when the house is to be yours (you were asked to build yourself a house, or it is for your own goal): it is then your own house, not the asker's`);
});

test("the build line of a family with no other family has no look-up sentence", () => {
  const alone = new Map([...fixture].filter(([, template]) => template.family === "europe"));
  assert.doesNotMatch(skillUsage("build", "europe", alone), /Other house families/u);
});

test("the build line of a family the registry lacks says so instead of listing nothing", () => {
  assert.match(skillUsage("build", "atlantis", fixture), /You know no atlantis houses; other house families you know: east-asia, europe:/u);
});

test("the list_houses line says each house line ends with the step that builds it", () => {
  assert.match(skillUsage("list_houses", "europe", fixture), /each line ends with the step that builds it/u);
  assert.doesNotMatch(skillUsage("list_houses", "europe", fixture), /then build any of them with its id/u);
});

test("improve_house swaps back for the house's own blocks", () => {
  assert.match(skillUsage("improve_house", "europe"), /for the house's own blocks/u);
});
