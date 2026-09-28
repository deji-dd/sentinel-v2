console.log(`
Oil Rig Management Scripts:
  bun run scripts/oil-rig/snapshot.ts             Capture and persist company snapshot to DB
  bun run scripts/oil-rig/role-audit.ts           Audit staff against optimal role stat thresholds
  bun run scripts/oil-rig/lineup-optimizer.ts     Generate optimal role assignments & wage model
  bun run scripts/oil-rig/director-briefing.ts    Generate and send director briefing
  bun run scripts/oil-rig/competitor-benchmark.ts Benchmark against competitor 10★ rigs
`);
