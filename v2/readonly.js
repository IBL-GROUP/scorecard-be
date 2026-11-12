// Read-only guard (story S2, AC-S2-6). Every statement is checked here before
// it is sent to BigQuery. Only a single SELECT (or WITH … SELECT) passes.
//
// This is the second line of defence. The first is the service account, which
// must hold only BigQuery Data Viewer + Job User, so BigQuery itself refuses
// writes. No code path calls a load, copy, extract, insert or table-create API.

const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE",
  "CREATE", "DROP", "ALTER", "REPLACE TABLE", "RENAME",
  "GRANT", "REVOKE", "EXPORT", "LOAD DATA", "CALL", "EXECUTE IMMEDIATE",
  "DECLARE", "SET", "BEGIN", "COMMIT", "ROLLBACK", "ASSERT",
];

/** Removes comments and the contents of string literals, so keywords inside them don't count. */
export function stripSql(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`[^`]*`/g, "``");
}

export class ReadOnlyViolation extends Error {
  constructor(reason) {
    super(`Refused: only read-only SELECT statements may run (${reason})`);
    this.code = "READ_ONLY_VIOLATION";
  }
}

/** Throws ReadOnlyViolation unless `sql` is one read-only SELECT/WITH statement. */
export function assertReadOnly(sql) {
  const s = stripSql(sql).trim();
  if (!s) throw new ReadOnlyViolation("empty statement");
  if (!/^\(?\s*(SELECT|WITH)\b/i.test(s)) throw new ReadOnlyViolation("does not start with SELECT or WITH");
  const body = s.replace(/;\s*$/, "");
  if (body.includes(";")) throw new ReadOnlyViolation("more than one statement");
  for (const kw of FORBIDDEN) {
    const re = new RegExp(`\\b${kw.replace(" ", "\\s+")}\\b`, "i");
    if (re.test(body)) throw new ReadOnlyViolation(`contains ${kw}`);
  }
  return true;
}
