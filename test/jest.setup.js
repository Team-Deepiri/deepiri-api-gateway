const fs = require('fs');
const path = require('path');

const METRICS_ENABLED = process.env.RESILIENCE_METRICS === '1' || process.env.METRICS_MODE === 'test';

if (METRICS_ENABLED) {
  const metrics = require(path.join(__dirname, '..', 'dist', 'utils', 'metrics.js'));

  beforeEach(() => {
    if (metrics && metrics.reset) metrics.reset();
  });

  afterEach(async () => {
    try {
      const totals = await metrics.collectTotals();
      const artifactDir = path.join(process.cwd(), 'artifacts');
      fs.mkdirSync(artifactDir, { recursive: true });
      const outPath = path.join(artifactDir, 'resilience-metrics.json');

      let existing = {};
      if (fs.existsSync(outPath)) {
        try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8') || '{}'); } catch (e) { existing = {}; }
      }

      // merge totals into existing
      for (const metricName of Object.keys(totals || {})) {
        existing[metricName] = existing[metricName] || {};
        const labels = totals[metricName] || {};
        for (const lbl of Object.keys(labels)) {
          const val = labels[lbl] || 0;
          existing[metricName][lbl] = (existing[metricName][lbl] || 0) + val;
        }
      }

      fs.writeFileSync(outPath, JSON.stringify(existing, null, 2), 'utf8');
    } catch (err) {
      // ignore per-test collect errors
    }

    // reset metrics after collecting per-test totals
    if (metrics && metrics.reset) metrics.reset();
  });
}
