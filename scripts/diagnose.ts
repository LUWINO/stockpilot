/**
 * Diagnostic: show exactly what the decision engine sees and concludes for every
 * SKU/site pair, without persisting anything.
 *
 * Useful when the agent produces no decisions and you want to know whether that
 * is because nothing is wrong, or because the data never reached it.
 *
 * Usage: `node --experimental-strip-types scripts/diagnose.ts`
 */

import { getEnv } from '../src/server/env.ts';
import { closePool, withOrg, withoutOrgScope } from '../src/server/db/client.ts';
import { organisations } from '../src/server/db/schema.ts';
import { listActiveSkuSites, loadStockContext, loadAnnualValues } from '../src/server/repositories/inventory.ts';
import { catalogueAbc, evaluate } from '../src/core/agent/decision-engine.ts';
import { DEFAULT_AUTONOMY } from '../src/core/agent/autonomy.ts';

async function main(): Promise<void> {
  getEnv();

  const [org] = await withoutOrgScope(async (db) => db.select().from(organisations).limit(1));
  if (org === undefined) throw new Error('No organisation found — run the seed first.');

  await withOrg(org.id, async (tx) => {
    const refs = await listActiveSkuSites(tx);
    const abc = catalogueAbc(await loadAnnualValues(tx));
    const today = new Date();

    for (const ref of refs) {
      const context = await loadStockContext(tx, ref, today);
      if (context === null) {
        console.log(`\n${ref.skuId} — no context`);
        continue;
      }

      const result = evaluate({
        context,
        movements: [],
        today: today.toISOString().slice(0, 10),
        policy: DEFAULT_AUTONOMY,
        ...(abc.get(ref.skuId) === undefined ? {} : { abc: abc.get(ref.skuId)! }),
      });

      console.log(`\n═══ ${context.sku.code} ═══`);
      console.log(`  history points   : ${context.demandHistory.length}`);
      console.log(`  on hand / order  : ${context.onHand} / ${context.onOrder}`);
      console.log(`  lots loaded      : ${context.lots.length}`);
      console.log(`  segment          : ${result.segment.abc}${result.segment.xyz} ` +
        `(service ${(result.segment.serviceLevel * 100).toFixed(0)}%, review ${result.segment.reviewPeriodDays}d)`);
      console.log(`  forecast         : ${result.forecast.method} @ ${result.forecast.dailyRate.toFixed(2)}/day ` +
        `(${result.forecast.classification.pattern}, confidence ${result.confidence})`);
      console.log(`  reorder point    : ${result.plan.reorderPoint}  (position ${result.plan.inventoryPosition})`);
      console.log(`  safety stock     : ${result.plan.safetyStock}`);
      console.log(`  cover days       : ${result.plan.coverDaysNow.toFixed(1)}`);
      console.log(`  should order     : ${result.plan.shouldOrder}`);
      console.log(`  anomalies        : ${result.anomalies.map((a) => a.kind).join(', ') || 'none'}`);
      console.log(`  decisions        : ${result.decisions.map((d) => `${d.kind}(${d.outcome})`).join(', ') || 'none'}`);
    }
  });
}

main()
  .catch((error: unknown) => {
    console.error('Diagnostic failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
