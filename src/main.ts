import { bootApp } from "./app-boot";
import { baseRulesetForSave, fetchRuleset } from "./ruleset/ruleset";

await bootApp({
  initialSaveText: async () => {
    const res = await fetch("saves/aztecs-turn0.unciv");
    if (!res.ok) throw new Error(`fetch save: ${res.status}`);
    return res.text();
  },
  rulesetFor: (game) => fetchRuleset(baseRulesetForSave(game)),
});
