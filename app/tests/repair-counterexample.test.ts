import { expect, it } from "vitest";
import { counterexampleInput, applyCounterexample } from "../src/domain/repair-counterexample";

const original = {input:{quantity:"1.5",lines:[{unit:"mg"}]},steps:{reader:{quantity:"1.5"}}};
const probe = (path: string[], value: unknown) => counterexampleInput.parse({
  rationale:"A changed quantity must remain distinguishable.",
  changes:[{path,value}], expectations:[{path:["same"],expected:false}],
});
it("changes only a cloned diagnostic input and preserves decimal distinctions", () => {
  const result = applyCounterexample(original,probe(["steps","reader","quantity"],"15"));
  expect(result.steps).toEqual({reader:{quantity:"15"}});
  expect(original.steps.reader.quantity).toBe("1.5");
  expect(applyCounterexample(original,probe(["input","lines","0","unit"],"g")).input)
    .toEqual({quantity:"1.5",lines:[{unit:"g"}]});
});
it("rejects invented paths, sparse indexes, prototype paths and excessive probes", () => {
  for (const path of [["input","missing"],["input","lines","1"],["input","lines","length"],["steps","__proto__"],["config","model"]])
    expect(()=>applyCounterexample(original,probe(path,"changed"))).toThrow();
  expect(()=>counterexampleInput.parse({...probe(["input","quantity"],"15"),changes:Array(9).fill({path:["input","quantity"],value:"15"})})).toThrow();
  expect(()=>applyCounterexample(original,probe(["input","quantity"],"x".repeat(50001)))).toThrow();
});
