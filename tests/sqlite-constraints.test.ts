import { describe, expect, it } from 'vitest';
import { assertD1FunctionArguments } from './sqlite-constraints';
describe('D1 function argument bound in local SQLite tests', () => {
  it('rejects a JSON object that local SQLite accepts but D1 rejects', () => {
    const fields = Array.from({ length: 17 }, (_, index) => `'field-${index}',${index}`).join(',');
    expect(() => assertD1FunctionArguments(`SELECT json_object(${fields})`)).toThrow('32');
  });
  it('counts nested calls independently and ignores quoted commas and comments', () => {
    const fields = Array.from({ length: 16 }, (_, index) => `'field-${index}',${index}`).join(',');
    expect(() =>
      assertD1FunctionArguments(
        `SELECT json_patch(json_object(${fields}),json_object('note','one, two',/* , */'nested',json_array(1,2,3)))`,
      ),
    ).not.toThrow();
    expect(() =>
      assertD1FunctionArguments(
        "SELECT 'json_object(a,b,c)',json_object('quote','it''s, fine') -- (,\n",
      ),
    ).not.toThrow();
  });
});
