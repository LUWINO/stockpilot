/**
 * Seed a demonstration organisation.
 *
 * Creates a tenant with two sites, three suppliers and a small catalogue, then
 * generates a year of movement history with genuinely different demand shapes —
 * a smooth staple, a weekly-seasonal line, an intermittent spare and a perishable.
 *
 * The variety is the point. A seed where every SKU sells twenty a day makes the
 * agent look flawless and proves nothing; these four exercise four different
 * forecasting methods and produce visibly different decisions on the first run.
 *
 * Usage: `npm run seed`
 *
 * Refuses to run against a database that already contains an organisation, so it
 * cannot be pointed at production by accident.
 */

import { randomUUID } from 'node:crypto';
import { getEnv } from '../src/server/env.ts';
import { closePool, getDb } from '../src/server/db/client.ts';
import {
  dailyDemand,
  lots,
  organisations,
  sites,
  skuSites,
  skus,
  stockMovements,
  suppliers,
  users,
} from '../src/server/db/schema.ts';
import { hashPassword } from '../src/server/auth/password.ts';

/** Deterministic generator, so a seeded database is identical every time. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

const random = seededRandom(20260817);

interface DemandShape {
  readonly code: string;
  readonly name: string;
  readonly unitCost: number;
  readonly unitPrice: number;
  readonly perishable: boolean;
  readonly shelfLifeDays: number | null;
  /** Units sold on day `n`. */
  readonly demand: (day: number) => number;
}

const CATALOGUE: DemandShape[] = [
  {
    code: 'FLOUR-25KG',
    name: 'Strong white flour, 25kg sack',
    unitCost: 1_850,
    unitPrice: 3_200,
    perishable: false,
    shelfLifeDays: null,
    // Smooth, steady demand: exponential smoothing territory.
    demand: (day) => Math.max(0, Math.round(18 + (random() - 0.5) * 5 + day * 0.01)),
  },
  {
    code: 'BREAD-SOURDOUGH',
    name: 'Sourdough loaf, 800g',
    unitCost: 90,
    unitPrice: 420,
    perishable: true,
    shelfLifeDays: 4,
    // Strong weekend peak: this is what Holt–Winters exists for.
    demand: (day) => {
      const weekday = day % 7;
      const weekend = weekday === 5 || weekday === 6 ? 1.9 : 1;
      return Math.max(0, Math.round(60 * weekend + (random() - 0.5) * 12));
    },
  },
  {
    code: 'MIXER-BEARING',
    name: 'Spiral mixer drive bearing',
    unitCost: 12_400,
    unitPrice: 24_000,
    perishable: false,
    shelfLifeDays: null,
    // Intermittent: mostly zeros. Plain smoothing under-forecasts this badly,
    // which is exactly why Croston is in the candidate set.
    demand: (day) => (day % 47 === 0 ? 1 + Math.floor(random() * 2) : 0),
  },
  {
    code: 'BUTTER-BLOCK',
    name: 'Unsalted butter, 2kg block',
    unitCost: 1_120,
    unitPrice: 1_950,
    perishable: true,
    shelfLifeDays: 30,
    // Erratic: real volume, high variance.
    demand: (day) => Math.max(0, Math.round(12 + (random() - 0.5) * 18 + (day % 30 < 5 ? 8 : 0))),
  },
];

const HISTORY_DAYS = 365;

async function main(): Promise<void> {
  getEnv();
  const db = getDb();

  const existing = await db.select({ id: organisations.id }).from(organisations).limit(1);
  if (existing.length > 0) {
    console.error(
      'Refusing to seed: this database already contains an organisation.\n' +
        'Seeding is for empty development databases only.',
    );
    process.exitCode = 1;
    return;
  }

  const orgId = randomUUID();
  const today = new Date();

  console.log('Creating organisation…');
  await db.insert(organisations).values({
    id: orgId,
    name: 'Northgate Bakery Group',
    currency: 'GBP',
    timezone: 'Europe/London',
    // Start in propose-only mode. A new install should demonstrate its reasoning
    // before it is trusted to spend money unattended.
    autonomy: 'propose',
    maxAutoValue: 25_000,
    maxDailyAutoValue: 250_000,
    minConfidence: 0.6,
  });

  const password = 'change-this-password-immediately';
  await db.insert(users).values({
    orgId,
    email: 'owner@example.com',
    passwordHash: await hashPassword(password),
    displayName: 'Demo Owner',
    role: 'owner',
  });

  const siteIds = { main: randomUUID(), depot: randomUUID() };
  await db.insert(sites).values([
    { id: siteIds.main, orgId, code: 'MAIN', name: 'Main bakery' },
    { id: siteIds.depot, orgId, code: 'DEPOT', name: 'Distribution depot' },
  ]);

  const supplierIds = { mill: randomUUID(), dairy: randomUUID(), parts: randomUUID() };
  await db.insert(suppliers).values([
    {
      id: supplierIds.mill,
      orgId,
      code: 'MILL',
      name: 'Northern Mills',
      nominalLeadTimeDays: 5,
      minimumOrderQuantity: 10,
      orderMultiple: 5,
      orderingCost: 2_500,
    },
    {
      id: supplierIds.dairy,
      orgId,
      code: 'DAIRY',
      name: 'Vale Dairy',
      nominalLeadTimeDays: 2,
      minimumOrderQuantity: 20,
      orderMultiple: 10,
      orderingCost: 1_200,
    },
    {
      // A deliberately slow and unreliable supplier, so the safety-stock maths
      // has something to react to.
      id: supplierIds.parts,
      orgId,
      code: 'PARTS',
      name: 'Industrial Spares Ltd',
      nominalLeadTimeDays: 21,
      minimumOrderQuantity: 1,
      orderMultiple: 1,
      orderingCost: 4_500,
    },
  ]);

  console.log(`Creating ${CATALOGUE.length} SKUs and ${HISTORY_DAYS} days of history…`);

  for (const item of CATALOGUE) {
    const skuId = randomUUID();
    const supplierId =
      item.code === 'MIXER-BEARING'
        ? supplierIds.parts
        : item.code === 'BUTTER-BLOCK'
          ? supplierIds.dairy
          : supplierIds.mill;

    await db.insert(skus).values({
      id: skuId,
      orgId,
      code: item.code,
      name: item.name,
      unitCost: item.unitCost,
      unitPrice: item.unitPrice,
      currency: 'GBP',
      perishable: item.perishable,
      shelfLifeDays: item.shelfLifeDays,
      supplierId,
    });

    const demandRows: (typeof dailyDemand.$inferInsert)[] = [];
    const movementRows: (typeof stockMovements.$inferInsert)[] = [];
    let onHand = 0;

    for (let day = 0; day < HISTORY_DAYS; day += 1) {
      const date = new Date(today.getTime() - (HISTORY_DAYS - day) * 86_400_000);
      const quantity = item.demand(day);

      // Replenish when stock would not cover the next fortnight.
      if (onHand < quantity * 14) {
        const receipt = Math.max(1, quantity * 21);
        onHand += receipt;
        movementRows.push({
          orgId,
          skuId,
          siteId: siteIds.main,
          kind: 'RECEIPT',
          quantity: receipt,
          actor: 'system:seed',
          occurredAt: date,
        });
      }

      if (quantity > 0) {
        const issued = Math.min(quantity, onHand);
        onHand -= issued;

        movementRows.push({
          orgId,
          skuId,
          siteId: siteIds.main,
          kind: 'ISSUE',
          quantity: issued,
          actor: 'system:seed',
          occurredAt: date,
        });

        demandRows.push({
          orgId,
          skuId,
          siteId: siteIds.main,
          day: date.toISOString().slice(0, 10),
          quantity: issued,
        });
      }
    }

    // Batched to keep the parameter count per statement well inside Postgres'
    // 65,535 limit.
    for (const batch of chunk(movementRows, 500)) await db.insert(stockMovements).values(batch);
    for (const batch of chunk(demandRows, 500)) await db.insert(dailyDemand).values(batch);

    await db.insert(skuSites).values({
      orgId,
      skuId,
      siteId: siteIds.main,
      onHand,
      lastIssuedAt: today,
    });

    if (item.perishable) {
      await db.insert(lots).values({
        orgId,
        skuId,
        siteId: siteIds.main,
        code: `LOT-${item.code}-001`,
        // Deliberately near expiry, so the first agent run has something real to
        // say about markdowns.
        expiresOn: new Date(today.getTime() + 3 * 86_400_000).toISOString().slice(0, 10),
        receivedAt: today,
      });
    }

    console.log(`  ${item.code}: ${movementRows.length} movements, ${onHand} on hand`);
  }

  console.log('\nSeed complete.');
  console.log('  Sign in with owner@example.com');
  console.log(`  Password: ${password}`);
  console.log('\nChange that password before exposing this instance to a network.');
  console.log('Then run a first agent sweep with:  RUN_ONCE=true npm run agent');
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
