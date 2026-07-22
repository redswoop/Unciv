import { bootApp } from "./app-boot";
import { baseRulesetForSave, fetchRuleset } from "./ruleset/ruleset";

await bootApp({
  initialSaveText: async () => {
    const res = await fetch("saves/turn518-14civs.unciv");
    if (!res.ok) throw new Error(`fetch save: ${res.status}`);
    return res.text();
  },
  rulesetFor: (game) => fetchRuleset(baseRulesetForSave(game)),
});
