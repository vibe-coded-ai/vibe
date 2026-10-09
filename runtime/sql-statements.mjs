// Split a SQL script into individual statements, stripping `--` line comments and
// `/* */` block comments, while respecting string literals. Avoids the newline-
// collapse footgun where a `--` comment swallows the rest of a seed file.
export function splitSqlStatements(sql) {
  const statements = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {            // line comment → skip to EOL
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {            // block comment → skip to */
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {               // string literal → copy verbatim
      const quote = c;
      cur += c; i++;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { cur += sql[i + 1]; i += 2; continue; } // escaped ''
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (c === ';') { statements.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) statements.push(cur.trim());
  return statements.filter(Boolean);
}
