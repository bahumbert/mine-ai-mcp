// Helpers shared by the get_items tests that smelt: a runtime whose furnace recipes and inventory are set, and the smelt calls it made.
import { FakeRuntime } from "../testing.ts";
import { GLASS_RECIPES } from "./skill-fixtures.test.ts";

export function smeltRuntime(inventory: { name: string; count: number }[] = []): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.recipes = GLASS_RECIPES;
  runtime.smelting = { glass: ["sand", "red_sand"], iron_ingot: ["deepslate_iron_ore", "iron_ore", "raw_iron"], coal: ["coal_ore", "deepslate_coal_ore"], cooked_beef: ["beef"] };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory };
  return runtime;
}

export function smeltCalls(runtime: FakeRuntime) {
  return runtime.submitted.filter((call) => call.tool === "smelt_item").map((call) => call.input);
}
