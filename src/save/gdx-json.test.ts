import { describe, expect, test } from "bun:test";
import { parseGdxJson } from "./gdx-json";

describe("parseGdxJson", () => {
  test("parses strict JSON", () => {
    expect(parseGdxJson('{"a": 1, "b": [true, null, "x"]}')).toEqual({
      a: 1,
      b: [true, null, "x"],
    });
  });

  test("parses libGDX minimal JSON — unquoted names and values", () => {
    expect(
      parseGdxJson("{civName:Barbarians,gold:-1427,tech:{},list:[Flight,Steam Power]}"),
    ).toEqual({
      civName: "Barbarians",
      gold: -1427,
      tech: {},
      list: ["Flight", "Steam Power"],
    });
  });

  test("unquoted strings with spaces survive intact", () => {
    expect(parseGdxJson("{name:Leaning Tower of Pisa}")).toEqual({
      name: "Leaning Tower of Pisa",
    });
  });

  test("version-like strings stay strings", () => {
    expect(parseGdxJson("{v:4.2.13}")).toEqual({ v: "4.2.13" });
  });

  test("numbers, booleans, null, scientific notation", () => {
    expect(
      parseGdxJson("{i:-3,f:0.5,e:1.4E-45,t:true,fa:false,n:null,seed:1623556758342}"),
    ).toEqual({
      i: -3,
      f: 0.5,
      e: 1.4e-45,
      t: true,
      fa: false,
      n: null,
      seed: 1623556758342,
    });
  });

  test("position objects with omitted components", () => {
    expect(parseGdxJson("[{position:{y:-1}},{position:{}},{position:{x:2,y:3}}]")).toEqual([
      { position: { y: -1 } },
      { position: {} },
      { position: { x: 2, y: 3 } },
    ]);
  });

  test("quoted strings with escapes", () => {
    expect(parseGdxJson('{s:"a\\"b\\n\\u00e9"}')).toEqual({ s: 'a"b\né' });
  });

  test("empty quoted string value", () => {
    expect(parseGdxJson('{type:StartIntro,value:""}')).toEqual({
      type: "StartIntro",
      value: "",
    });
  });

  test("ruleset dialect: comments, tabs, trailing commas", () => {
    const text = `[
\t// Base terrains
\t{
\t\t"name": "Ocean", /* water */
\t\t"RGB": [43, 87, 151],
\t},
]`;
    expect(parseGdxJson(text)).toEqual([{ name: "Ocean", RGB: [43, 87, 151] }]);
  });

  test("java boxed values parse as plain objects", () => {
    expect(parseGdxJson("{Artist:{class:java.lang.Integer,value:4}}")).toEqual({
      Artist: { class: "java.lang.Integer", value: 4 },
    });
  });

  test("rejects garbage", () => {
    expect(() => parseGdxJson("{a:1")).toThrow();
    expect(() => parseGdxJson("{a 1}")).toThrow();
  });
});
