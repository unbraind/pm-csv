import { getHeapStatistics } from "node:v8";
import { admitCSV, AdmissionRefusal } from "../../admission.ts";
import { importCSV } from "../../index.ts";
import { commitWorkspaceTransaction } from "@unbrained/pm-cli/sdk";

if (process.argv[4] === "invalid-final") {
  try {
    await importCSV(process.argv[2], process.argv[3], { delimiter: ",", fieldMap: {}, dryRun: false, atomic: true, admission: {},
      commitTransaction: options => commitWorkspaceTransaction({ ...options, pmRoot: process.argv[2] }) });
    throw new Error("An invalid million-row tail was applied.");
  } catch (error) {
    if (!(error instanceof AdmissionRefusal) || error.code !== "csv_admission_invalid") throw error;
  }
  console.log(JSON.stringify({ invalidFinalRefused: true, heapLimit: getHeapStatistics().heap_size_limit }));
} else {
  const receipt = await admitCSV(process.argv[2], process.argv[3]);
  if (!receipt.ok || !receipt.complete) throw new Error("Million-row admission did not finish validation.");
  console.log(JSON.stringify({ rows: receipt.rows.value, sourceBytes: receipt.sourceBytes,
    heapUsed: process.memoryUsage().heapUsed, heapLimit: getHeapStatistics().heap_size_limit }));
}
