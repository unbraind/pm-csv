import assert from "node:assert/strict";
import { commitImportedItem, get, getItemPath, init, nowIso, readSettings, resolveRuntimeFieldRegistry, schemaAddField } from "@unbrained/pm-cli/sdk";

/** Custom columns whose values must survive the installed package's export. */
export const CUSTOM_FIELDS = [
  ["accept_text", "string"],
  ["accept_number", "number"],
  ["accept_boolean", "boolean"],
  // Runtime schemas represent dates as ISO strings, rather than a separate type.
  ["accept_date", "string"],
  ["accept_list", "string_array"],
  ["accept_empty", "string"],
] as const;

/** Opposite truthiness and empty-list cases prevent value-presence shortcuts. */
export const CUSTOM_FIXTURES = [
  { title: "Packed custom zero", accept_text: 'Quoted, "custom"\nsecond line', accept_number: 0,
    accept_boolean: false, accept_date: "2026-10-25", accept_list: ["red", "blue"], accept_empty: "" },
  { title: "Packed custom positive", accept_text: "Plain custom", accept_number: 12.5,
    accept_boolean: true, accept_date: "2026-10-26", accept_list: [], accept_empty: "" },
] as const;

/** Typed cells accepted by the SDK import adapter, independent of fixture literals. */
type CustomValue = string | number | boolean | string[];

/** Persist one typed CSV fixture with real import history through the selected SDK. */
async function commitFixture(pmRoot: string, index: number, title: string, values: Record<string, CustomValue>): Promise<string> {
  const settings = await readSettings(pmRoot);
  const id = `${settings.id_prefix}-custom-${index}`;
  const timestamp = nowIso();
  const result = await commitImportedItem({ pmRoot, id,
    itemPath: getItemPath(pmRoot, "Task", id), settings, author: "packed-acceptance",
    message: "Import typed custom-field acceptance fixture", conflictWarningPrefix: "acceptance_fixture",
    document: { metadata: { ...values, title, id, description: "", type: "Task", status: "open",
      priority: 2, tags: [], created_at: timestamp, updated_at: timestamp }, body: "" } });
  assert.equal(result.committed, true, "SDK fixture commit");
  return id;
}

/** Register each custom field through the selected host's public SDK. */
export async function registerCustomFields(pmRoot: string): Promise<void> {
  for (const [name, type] of CUSTOM_FIELDS) {
    // The minimum SDK dispatcher reads fieldType, while current hosts use type.
    const options = { type, fieldType: type };
    await schemaAddField(name, options, { pmRoot });
  }
  const registry = resolveRuntimeFieldRegistry((await readSettings(pmRoot)).schema);
  for (const [name, type] of CUSTOM_FIELDS) {
    assert.equal(registry.definitions.find(field => field.key === name)?.type, type, `SDK schema ${name}`);
  }
}

/** Create real custom metadata and check its persisted SDK projection before export. */
export async function seedCustomFields(pmRoot: string): Promise<string[]> {
  await registerCustomFields(pmRoot);
  const ids: string[] = [];
  for (const [index, fixture] of CUSTOM_FIXTURES.entries()) {
    const id = await commitFixture(pmRoot, index, fixture.title, { ...fixture, accept_list: [...fixture.accept_list] });
    const saved = await get(id, { full: true }, { pmRoot });
    for (const [column] of CUSTOM_FIELDS) assert.deepEqual(saved.item[column], fixture[column], `SDK seed ${column}`);
    ids.push(id);
  }
  return ids;
}

/** Decode packed CSV cells into a fresh tracker and compare persisted SDK reads.
 * This tests the SDK import adapter; the legacy CSV importer supports built-ins.
 */
export async function reimportCustomFields(sourceRoot: string, targetRoot: string, table: string[][]): Promise<void> {
  assertCustomFieldExport(table);
  await init("roundtrip", { defaults: true, agentGuidance: "skip" }, { pmRoot: targetRoot });
  await registerCustomFields(targetRoot);
  const sourceSettings = await readSettings(sourceRoot);
  const [header, ...rows] = table;
  for (const [index, fixture] of CUSTOM_FIXTURES.entries()) {
    const row = rows.find(row => row[header.indexOf("title")] === fixture.title)!;
    const values: Record<string, CustomValue> = {};
    for (const [column, type] of CUSTOM_FIELDS) {
      const cell = row[header.indexOf(column)];
      values[column] = type === "number" ? Number(cell) : type === "boolean" ? cell === "true"
        : type === "string_array" ? (cell === "" ? [] : cell.split(",")) : cell;
    }
    const id = await commitFixture(targetRoot, index, row[header.indexOf("title")], values);
    const source = await get(`${sourceSettings.id_prefix}-custom-${index}`, { full: true }, { pmRoot: sourceRoot });
    const imported = await get(id, { full: true }, { pmRoot: targetRoot });
    assert.equal(imported.item.title, source.item.title, "SDK roundtrip title");
    for (const [column] of CUSTOM_FIELDS) assert.deepEqual(imported.item[column], source.item[column], `SDK roundtrip ${column}`);
  }
}

/** Assert column identities and every fixture cell, including empty and false values. */
export function assertCustomFieldExport(table: string[][]): void {
  const [header, ...rows] = table;
  for (const [column] of CUSTOM_FIELDS) {
    assert.equal(header.filter(value => value === column).length, 1, `custom column ${column}`);
  }
  for (const fixture of CUSTOM_FIXTURES) {
    const matches = rows.filter(row => row[header.indexOf("title")] === fixture.title);
    assert.equal(matches.length, 1, `custom fixture ${fixture.title}`);
    for (const [column] of CUSTOM_FIELDS) {
      const value = fixture[column];
      const expected = Array.isArray(value) ? value.join(",") : String(value);
      assert.equal(matches[0][header.indexOf(column)], expected, `custom value ${fixture.title}: ${column}`);
    }
  }
}
