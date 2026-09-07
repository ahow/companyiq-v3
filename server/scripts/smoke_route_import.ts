// Verify the route module (with new EK wiring) imports without load-time errors.
import("../routes/framework-builder-v2.js")
  .then(() => console.log("OK: framework-builder-v2 imported cleanly (EK wiring load-safe)"))
  .catch((e) => { console.error("IMPORT FAILED:", e?.message || e); process.exit(1); });
