import { bootApp } from "./app-boot";
import { baseRulesetForSave, fetchRuleset } from "./ruleset/ruleset";

await bootApp({
  initialSaveText: async () => {
    // ?save=turn518-14civs loads another bundled save from public/saves/
    const name = new URLSearchParams(location.search).get("save") ?? "aztecs-turn0";
    const res = await fetch(`saves/${encodeURIComponent(name)}.unciv`);
    if (!res.ok) throw new Error(`fetch save: ${res.status}`);
    return res.text();
  },
  rulesetFor: (game) => fetchRuleset(baseRulesetForSave(game)),
});
