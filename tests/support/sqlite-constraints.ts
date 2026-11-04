const boundedFunctions = new Set(['json_object', 'json_array', 'coalesce', 'printf', 'max', 'min']);

/** Node's SQLite may allow more function arguments than the deployed D1 engine. */
export function assertD1FunctionArguments(sql: string): void {
  const stack: { name: string; commas: number; hasContent: boolean }[] = [];
  let identifier = '';
  const content = () => {
    const current = stack.at(-1);
    if (current) current.hasContent = true;
  };
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]!;
    if (/\s/.test(character)) continue;
    if (character === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') index++;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index++;
      index++;
      continue;
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      content();
      identifier = '';
      const end = character === '[' ? ']' : character;
      for (index++; index < sql.length; index++)
        if (sql[index] === end) {
          if (sql[index + 1] === end) index++;
          else break;
        }
      continue;
    }
    if (/[a-z_]/i.test(character)) {
      content();
      let end = index + 1;
      while (end < sql.length && /[a-z_0-9]/i.test(sql[end]!)) end++;
      identifier = sql.slice(index, end).toLowerCase();
      index = end - 1;
      continue;
    }
    if (character === '(') {
      content();
      stack.push({ name: identifier, commas: 0, hasContent: false });
      identifier = '';
      continue;
    }
    if (character === ',') {
      const current = stack.at(-1);
      if (current) current.commas++;
      identifier = '';
      continue;
    }
    if (character === ')') {
      const current = stack.pop();
      if (
        current &&
        boundedFunctions.has(current.name) &&
        current.hasContent &&
        current.commas + 1 > 32
      )
        throw new Error(
          `D1 permits at most32 arguments to ${current.name}; received${current.commas + 1}.`,
        );
      identifier = '';
      continue;
    }
    content();
    identifier = '';
  }
}
